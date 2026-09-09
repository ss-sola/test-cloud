import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ResponseUtil } from '@nest-cloud/common';
import { ConfigFilePreviewDto } from './dto/config-file-preview.dto';
import { ConfigFilePreviewTagsDto } from './dto/config-file-preview-tags.dto';
import { ConfigFilePreviewService } from './config-file-preview.service';

@Controller('api/config-file-preview')
export class ConfigFilePreviewController {
  constructor(private readonly previewService: ConfigFilePreviewService) {}

  @Post('tags')
  @HttpCode(HttpStatus.OK)
  async getTags(@Body() body: ConfigFilePreviewTagsDto) {
    return ResponseUtil.success(await this.previewService.getTags(body));
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  async preview(
    @Body() body: ConfigFilePreviewDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const abortController = new AbortController();
    let completed = false;
    const abort = () => {
      if (!completed && !response.writableFinished) abortController.abort();
    };
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      const result = await this.previewService.preview(body, abortController.signal);
      completed = true;
      return ResponseUtil.success(result);
    } finally {
      request.off('aborted', abort);
      response.off('close', abort);
    }
  }
}
