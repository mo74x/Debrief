import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { ReviewService } from './review.service';

@Controller('review')
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  @Get()
  listOpen(@Query('orgId') orgId: string) {
    return this.reviewService.listOpenReviewItems(orgId);
  }

  @Post(':id/approve')
  approve(
    @Param('id') reviewId: string,
    @Body() body: { orgId: string; userId?: string; force?: boolean },
  ) {
    return this.reviewService.approveReviewItem(
      body.orgId,
      reviewId,
      body.userId,
      Boolean(body.force),
    );
  }

  @Post(':id/edit')
  editAndApprove(
    @Param('id') reviewId: string,
    @Body() body: { orgId: string; userId?: string } & Record<string, unknown>,
  ) {
    const { orgId, userId, ...proposalEdits } = body;
    return this.reviewService.editAndApproveReviewItem(
      orgId,
      reviewId,
      proposalEdits,
      userId,
    );
  }

  @Post(':id/reject')
  reject(
    @Param('id') reviewId: string,
    @Body() body: { orgId: string; userId?: string },
  ) {
    return this.reviewService.rejectReviewItem(
      body.orgId,
      reviewId,
      body.userId,
    );
  }
}
