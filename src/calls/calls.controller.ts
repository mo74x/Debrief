import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  NotFoundException,
} from '@nestjs/common';
import { CallStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ReviewService } from '../review/review.service';
import { UndoService } from '../audit/undo.service';

@Controller('calls')
export class CallsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reviewService: ReviewService,
    private readonly undoService: UndoService,
  ) {}

  @Get()
  async listCalls(
    @Query('orgId') orgId: string,
    @Query('status') status?: CallStatus,
  ) {
    return this.prisma.call.findMany({
      where: {
        orgId,
        ...(status ? { status } : {}),
      },
      select: {
        id: true,
        fathomCallId: true,
        title: true,
        startedAt: true,
        status: true,
        dealId: true,
        matchMethod: true,
        failureReason: true,
        createdAt: true,
      },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
  }

  @Get(':id')
  async getCallDetail(@Param('id') id: string, @Query('orgId') orgId: string) {
    const call = await this.prisma.call.findFirst({
      where: { id, orgId },
      include: {
        writes: { orderBy: { createdAt: 'asc' } },
        reviewItems: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!call) {
      throw new NotFoundException(`Call ${id} not found.`);
    }

    return call;
  }

  @Post(':id/match')
  async manualMatch(
    @Param('id') callId: string,
    @Body() body: { orgId: string; dealId: string; userId?: string },
  ) {
    return this.reviewService.manualMatchDeal(
      body.orgId,
      callId,
      body.dealId,
      body.userId,
    );
  }

  @Post(':id/undo-all')
  async undoAllForCall(
    @Param('id') callId: string,
    @Body() body: { orgId: string; userId?: string; force?: boolean },
  ) {
    return this.undoService.undoAllWritesForCall(
      body.orgId,
      callId,
      body.userId,
      Boolean(body.force),
    );
  }
}
