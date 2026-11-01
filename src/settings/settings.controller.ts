import { Controller, Get, Put, Query, Body } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../common/prisma/prisma.service';

const UpdateSettingsSchema = z.object({
  orgId: z.string().uuid(),
  autoWrite: z.boolean().optional(),
  confidenceMin: z.number().min(0.5).max(1.0).optional(),
  internalDomains: z.array(z.string()).optional(),
  transcriptRetentionDays: z.number().int().min(1).max(365).optional(),
  pipelineConfig: z.record(z.string(), z.unknown()).optional(),
});

@Controller('settings')
export class SettingsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async getSettings(@Query('orgId') orgId: string) {
    return this.prisma.org.findUniqueOrThrow({
      where: { id: orgId },
      select: {
        id: true,
        name: true,
        fathomWebhookKey: true,
        hubspotPortalId: true,
        internalDomains: true,
        autoWrite: true,
        confidenceMin: true,
        transcriptRetentionDays: true,
        pipelineConfig: true,
      },
    });
  }

  @Put()
  async updateSettings(@Body() body: unknown) {
    const dto = UpdateSettingsSchema.parse(body);

    return this.prisma.org.update({
      where: { id: dto.orgId },
      data: {
        ...(dto.autoWrite !== undefined ? { autoWrite: dto.autoWrite } : {}),
        ...(dto.confidenceMin !== undefined
          ? { confidenceMin: dto.confidenceMin }
          : {}),
        ...(dto.internalDomains !== undefined
          ? { internalDomains: dto.internalDomains }
          : {}),
        ...(dto.transcriptRetentionDays !== undefined
          ? { transcriptRetentionDays: dto.transcriptRetentionDays }
          : {}),
        ...(dto.pipelineConfig !== undefined
          ? { pipelineConfig: dto.pipelineConfig as Prisma.InputJsonValue }
          : {}),
      },
      select: {
        id: true,
        autoWrite: true,
        confidenceMin: true,
        internalDomains: true,
        transcriptRetentionDays: true,
        pipelineConfig: true,
      },
    });
  }
}
