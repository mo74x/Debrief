import * as common from '@nestjs/common';
import { Request } from 'express';
import { FathomService } from './fathom.service';

@common.Controller('webhooks/fathom')
export class FathomController {
  constructor(private readonly fathomService: FathomService) {}

  @common.Post(':fathomWebhookKey')
  @common.HttpCode(common.HttpStatus.OK)
  async handleFathomWebhook(
    @common.Param('fathomWebhookKey') fathomWebhookKey: string,
    @common.Headers('x-fathom-signature') signature: string | undefined,
    @common.Req() req: common.RawBodyRequest<Request>,
    @common.Body() body: unknown,
  ) {
    return this.fathomService.handleWebhook(
      fathomWebhookKey,
      req.rawBody,
      signature,
      body,
    );
  }
}
