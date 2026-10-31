import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../common/prisma/prisma.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { RedisService } from '../common/redis/redis.service';

interface HubSpotTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface HubSpotTokenMetaResponse {
  hub_id: number;
  user: string;
  scopes: string[];
}

@Injectable()
export class HubSpotOAuthService {
  private readonly logger = new Logger(HubSpotOAuthService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  // Minimum required scopes for Call-to-CRM
  private readonly scopes = [
    'crm.objects.contacts.read',
    'crm.objects.companies.read',
    'crm.objects.deals.read',
    'crm.objects.deals.write',
    'crm.objects.owners.read',
    'crm.schemas.deals.read',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {
    this.clientId = this.config.getOrThrow<string>('HUBSPOT_CLIENT_ID');
    this.clientSecret = this.config.getOrThrow<string>('HUBSPOT_CLIENT_SECRET');
    this.redirectUri = this.config.getOrThrow<string>('HUBSPOT_REDIRECT_URI');
  }

  /**
   * 1. Generates the HubSpot OAuth 2.0 authorization URL with state = orgId
   */
  getAuthorizationUrl(orgId: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: this.scopes.join(' '),
      state: orgId,
    });
    return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
  }

  /**
   * 2. Exchanges authorization code for initial tokens and records hubspotPortalId
   */
  async exchangeCodeForTokens(
    orgId: string,
    code: string,
  ): Promise<{ portalId: string }> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      code,
    });

    const tokenRes = await axios.post<HubSpotTokenResponse>(
      'https://api.hubapi.com/oauth/v1/token',
      form.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;

    // Fetch HubSpot Portal ID (hub_id) for this token
    const metaRes = await axios.get<HubSpotTokenMetaResponse>(
      `https://api.hubapi.com/oauth/v1/access-tokens/${access_token}`,
    );

    const portalId = String(metaRes.data.hub_id);
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    await this.prisma.org.update({
      where: { id: orgId },
      data: {
        hubspotPortalId: portalId,
        hubspotAccessTokenEnc: this.crypto.encrypt(access_token),
        hubspotRefreshTokenEnc: this.crypto.encrypt(refresh_token),
        hubspotTokenExpiresAt: expiresAt,
      },
    });

    this.logger.log({ msg: 'Connected HubSpot OAuth', orgId, portalId });
    return { portalId };
  }

  /**
   * 3. Returns a valid plaintext access token, refreshing under a Redis lock if within 2 minutes of expiry
   */
  async getValidAccessToken(orgId: string): Promise<string> {
    const bufferMs = 2 * 60 * 1000; // Refresh 2 minutes before actual expiration

    const org = await this.prisma.org.findUniqueOrThrow({
      where: { id: orgId },
      select: {
        hubspotAccessTokenEnc: true,
        hubspotRefreshTokenEnc: true,
        hubspotTokenExpiresAt: true,
      },
    });

    if (!org.hubspotAccessTokenEnc || !org.hubspotRefreshTokenEnc) {
      throw new UnauthorizedException(
        `Org ${orgId} has not connected HubSpot.`,
      );
    }

    if (
      org.hubspotTokenExpiresAt &&
      org.hubspotTokenExpiresAt.getTime() - Date.now() > bufferMs
    ) {
      return this.crypto.decrypt(org.hubspotAccessTokenEnc);
    }

    // Token is expiring or expired: acquire distributed lock per org
    const lockKey = `lock:hubspot:oauth:${orgId}`;
    return this.redis.withLock(lockKey, 15_000, async () => {
      // Double-check database inside lock in case another worker already refreshed it
      const freshOrg = await this.prisma.org.findUniqueOrThrow({
        where: { id: orgId },
        select: {
          hubspotAccessTokenEnc: true,
          hubspotRefreshTokenEnc: true,
          hubspotTokenExpiresAt: true,
        },
      });

      if (
        freshOrg.hubspotTokenExpiresAt &&
        freshOrg.hubspotTokenExpiresAt.getTime() - Date.now() > bufferMs &&
        freshOrg.hubspotAccessTokenEnc
      ) {
        return this.crypto.decrypt(freshOrg.hubspotAccessTokenEnc);
      }

      const refreshToken = this.crypto.decrypt(
        freshOrg.hubspotRefreshTokenEnc!,
      );
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
      });

      const response = await axios.post<HubSpotTokenResponse>(
        'https://api.hubapi.com/oauth/v1/token',
        form.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10_000,
        },
      );

      const {
        access_token,
        refresh_token: newRefreshToken,
        expires_in,
      } = response.data;
      const newExpiresAt = new Date(Date.now() + expires_in * 1000);

      await this.prisma.org.update({
        where: { id: orgId },
        data: {
          hubspotAccessTokenEnc: this.crypto.encrypt(access_token),
          hubspotRefreshTokenEnc: this.crypto.encrypt(newRefreshToken),
          hubspotTokenExpiresAt: newExpiresAt,
        },
      });

      this.logger.log({
        msg: 'Refreshed HubSpot OAuth token under lock',
        orgId,
      });
      return access_token;
    });
  }
}
