import { Controller, Post, Param, Body } from '@nestjs/common';
import { UndoService } from './undo.service';

@Controller('writes')
export class WritesController {
  constructor(private readonly undoService: UndoService) {}

  @Post(':id/undo')
  async undoSingleWrite(
    @Param('id') writeId: string,
    @Body() body: { orgId: string; userId?: string; force?: boolean },
  ) {
    return this.undoService.undoWrite(
      body.orgId,
      writeId,
      body.userId,
      Boolean(body.force),
    );
  }
}
