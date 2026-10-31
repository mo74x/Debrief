/* eslint-disable @typescript-eslint/no-base-to-string */
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { CrmWrite, CrmWriteStatus, CrmWriteType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { HubSpotService } from '../hubspot/hubspot.service';

export interface UndoConflictDetail {
  property: string;
  aiWroteValue: string | null;
  currentHubSpotValue: string | null;
  wouldRestoreToValue: string | null;
}

@Injectable()
export class UndoService {
  private readonly logger = new Logger(UndoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly hubspot: HubSpotService,
  ) {}

  /**
   * Reverts a single CrmWrite record.
   * Throws 409 ConflictException if the deal property was modified in HubSpot since the AI write (unless force=true).
   */
  async undoWrite(
    orgId: string,
    writeId: string,
    userId?: string,
    force = false,
  ): Promise<{ undoneWrite: CrmWrite; warnings: UndoConflictDetail[] }> {
    const write = await this.prisma.crmWrite.findFirst({
      where: { id: writeId, orgId },
    });

    if (!write) {
      throw new NotFoundException(`CrmWrite ${writeId} not found.`);
    }

    if (write.status === CrmWriteStatus.UNDONE) {
      throw new BadRequestException(
        `CrmWrite ${writeId} has already been undone.`,
      );
    }

    if (write.status !== CrmWriteStatus.WRITTEN) {
      throw new BadRequestException(
        `Cannot undo CrmWrite ${writeId} in status ${write.status}.`,
      );
    }

    const lockKey = `lock:deal:${orgId}:${write.dealId}`;
    return this.redis.withLock(lockKey, 20_000, async () => {
      const warnings: UndoConflictDetail[] = [];

      if (write.type === CrmWriteType.NOTE) {
        if (write.hubspotObjectId) {
          await this.hubspot.archiveObject(
            orgId,
            'notes',
            write.hubspotObjectId,
          );
        }
      } else if (write.type === CrmWriteType.TASK) {
        if (write.hubspotObjectId) {
          await this.hubspot.archiveObject(
            orgId,
            'tasks',
            write.hubspotObjectId,
          );
        }
      } else if (
        write.type === CrmWriteType.STAGE ||
        write.type === CrmWriteType.PROPERTY
      ) {
        const beforeObj = (write.before ?? {}) as Record<string, string | null>;
        const afterObj = (write.after ?? {}) as Record<string, unknown>;
        const propNames = Object.keys(beforeObj);

        if (propNames.length > 0) {
          const liveProps = await this.hubspot.getDealProperties(
            orgId,
            write.dealId,
            propNames,
          );

          for (const prop of propNames) {
            const aiAfterVal =
              afterObj[prop] !== undefined && afterObj[prop] !== null
                ? String(afterObj[prop])
                : null;
            const currentLiveVal = liveProps[prop] ?? null;

            if (aiAfterVal !== null && currentLiveVal !== aiAfterVal) {
              warnings.push({
                property: prop,
                aiWroteValue: aiAfterVal,
                currentHubSpotValue: currentLiveVal,
                wouldRestoreToValue: beforeObj[prop] ?? null,
              });
            }
          }

          if (warnings.length > 0 && !force) {
            throw new ConflictException({
              message:
                'Deal properties were modified in HubSpot after this AI write. Pass force=true to overwrite.',
              conflicts: warnings,
            });
          }

          await this.hubspot.updateDealProperties(
            orgId,
            write.dealId,
            beforeObj,
          );
        }
      }

      const undoneWrite = await this.prisma.crmWrite.update({
        where: { id: write.id },
        data: {
          status: CrmWriteStatus.UNDONE,
          undoneAt: new Date(),
          undoneById: userId ?? null,
        },
      });

      this.logger.log({
        msg: 'Successfully undid CRM write',
        orgId,
        writeId: write.id,
        callId: write.callId,
        type: write.type,
        forced: force,
      });

      return { undoneWrite, warnings };
    });
  }

  /**
   * Convenience method to undo all WRITTEN items for a given Call in reverse order
   */
  async undoAllWritesForCall(
    orgId: string,
    callId: string,
    userId?: string,
    force = false,
  ) {
    const writes = await this.prisma.crmWrite.findMany({
      where: { orgId, callId, status: CrmWriteStatus.WRITTEN },
      orderBy: { createdAt: 'desc' },
    });

    const results = [];
    for (const w of writes) {
      results.push(await this.undoWrite(orgId, w.id, userId, force));
    }
    return results;
  }
}
