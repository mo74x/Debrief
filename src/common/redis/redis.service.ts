import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  public readonly client: Redis;

  // Atomic check-and-delete script so an expired lock is never deleted by the wrong owner
  private readonly releaseLuaScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor(private readonly config: ConfigService) {
    this.client = new Redis({
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: this.config.get<number>('REDIS_PORT', 6379),
      maxRetriesPerRequest: 3,
    });
  }

  /**
   * Acquires a distributed lock with retries and executes fn().
   * Guarantees lock release even if fn() throws.
   */
  async withLock<T>(
    lockKey: string,
    ttlMs: number,
    fn: () => Promise<T>,
    maxWaitMs = 10_000,
  ): Promise<T> {
    const token = randomUUID();
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      const acquired = await this.client.set(lockKey, token, 'PX', ttlMs, 'NX');
      if (acquired === 'OK') {
        try {
          return await fn();
        } finally {
          await this.client
            .eval(this.releaseLuaScript, 1, lockKey, token)
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              this.logger.warn(
                `Failed to release Redis lock ${lockKey}: ${message}`,
              );
            });
        }
      }
      // Wait 100-200ms with jitter before polling again
      await new Promise((r) =>
        setTimeout(r, 100 + Math.floor(Math.random() * 100)),
      );
    }

    throw new Error(`Timed out waiting for Redis lock: ${lockKey}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
