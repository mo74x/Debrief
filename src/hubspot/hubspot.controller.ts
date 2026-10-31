import {
  Controller,
  Get,
  Query,
  Res,
  BadRequestException,
} from '@nestjs/common';
import express from 'express';
import { HubSpotOAuthService } from './hubspot-oauth.service';
import { HubSpotService } from './hubspot.service';

@Controller('connect/hubspot')
export class HubSpotController {
  constructor(
    private readonly oauthService: HubSpotOAuthService,
    private readonly hubspotService: HubSpotService,
  ) {}

  @Get()
  initiateOAuth(@Query('orgId') orgId: string, @Res() res: express.Response) {
    if (!orgId) {
      throw new BadRequestException('Query parameter orgId is required.');
    }
    const url = this.oauthService.getAuthorizationUrl(orgId);
    return res.redirect(url);
  }

  @Get('callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') orgId: string,
  ) {
    if (!code || !orgId) {
      throw new BadRequestException(
        'Missing code or state parameter from HubSpot OAuth.',
      );
    }

    const { portalId } = await this.oauthService.exchangeCodeForTokens(
      orgId,
      code,
    );

    // Sync Owners and Deal Pipelines immediately after connecting
    const [ownersMatched, pipelineConfig] = await Promise.all([
      this.hubspotService.syncOwners(orgId),
      this.hubspotService.syncDealPipelines(orgId),
    ]);

    return {
      status: 'connected',
      orgId,
      hubspotPortalId: portalId,
      ownersMatched,
      pipelinesSynced: Object.keys(pipelineConfig.pipelines).length,
    };
  }
}
