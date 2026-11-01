import { Controller, Get, Query } from '@nestjs/common';
import { CrmWriteStatus, ReviewStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

@Controller('stats')
export class StatsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async getOrgStats(@Query('orgId') orgId: string) {
    const [callCounts, reviewByReason, reviewByStatus, undoneCount] =
      await Promise.all([
        this.prisma.call.groupBy({
          by: ['status'],
          where: { orgId },
          _count: { _all: true },
        }),
        this.prisma.reviewItem.groupBy({
          by: ['reason'],
          where: { orgId },
          _count: { _all: true },
        }),
        this.prisma.reviewItem.groupBy({
          by: ['status'],
          where: { orgId },
          _count: { _all: true },
        }),
        this.prisma.crmWrite.count({
          where: { orgId, status: CrmWriteStatus.UNDONE },
        }),
      ]);

    const statusMap: Record<string, number> = {};
    let totalCalls = 0;
    for (const row of callCounts) {
      statusMap[row.status] = row._count._all;
      totalCalls += row._count._all;
    }

    const reviewStatusMap: Record<string, number> = {};
    for (const row of reviewByStatus) {
      reviewStatusMap[row.status] = row._count._all;
    }

    const approvedCount = reviewStatusMap[ReviewStatus.APPROVED] ?? 0;
    const editedCount = reviewStatusMap[ReviewStatus.EDITED] ?? 0;
    const rejectedCount = reviewStatusMap[ReviewStatus.REJECTED] ?? 0;
    const totalResolvedReviews = approvedCount + editedCount + rejectedCount;

    return {
      totalCalls,
      callsByStatus: statusMap,
      autoWriteRate:
        totalCalls > 0
          ? Number(((statusMap.WRITTEN ?? 0) / totalCalls).toFixed(3))
          : 0,
      reviewReasons: Object.fromEntries(
        reviewByReason.map((r) => [r.reason, r._count._all]),
      ),
      reviewOutcomes: reviewStatusMap,
      proposalAcceptanceRate:
        totalResolvedReviews > 0
          ? Number((approvedCount / totalResolvedReviews).toFixed(3))
          : null,
      writesUndoneCount: undoneCount,
    };
  }
}
