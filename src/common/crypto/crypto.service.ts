import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

@Injectable()
export class CryptoService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly masterKey: Buffer;

  constructor(private readonly config: ConfigService) {
    const keyHex = this.config.getOrThrow<string>('ENCRYPTION_KEY');
    if (keyHex.length !== 64) {
      throw new InternalServerErrorException(
        'ENCRYPTION_KEY must be a 64-character hex string (32 bytes).',
      );
    }
    this.masterKey = Buffer.from(keyHex, 'hex');
  }

  /**
   * Encrypts plaintext into format: ivHex:authTagHex:ciphertextHex
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12); // 96-bit IV recommended for AES-GCM
    const cipher = createCipheriv(this.algorithm, this.masterKey, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypts payload formatted as ivHex:authTagHex:ciphertextHex
   */
  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 3) {
      throw new InternalServerErrorException(
        'Malformed encrypted credential payload.',
      );
    }

    const [ivHex, authTagHex, ciphertextHex] = parts;
    const decipher = createDecipheriv(
      this.algorithm,
      this.masterKey,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, 'hex')),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Constant-time HMAC-SHA256 signature verification
   */
  verifyHmacSignature(
    rawBody: Buffer,
    secret: string,
    signatureHeader: string,
  ): boolean {
    if (!signatureHeader || !rawBody) return false;

    const cleanSig = signatureHeader.replace(/^sha256=/i, '').trim();
    const expectedHex = createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    const sigBuf = Buffer.from(cleanSig, 'hex');
    const expectedBuf = Buffer.from(expectedHex, 'hex');

    if (sigBuf.length !== expectedBuf.length) {
      return false;
    }

    return timingSafeEqual(sigBuf, expectedBuf);
  }
}
