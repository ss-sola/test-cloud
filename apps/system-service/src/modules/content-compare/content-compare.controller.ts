import { Body, Controller, HttpCode, HttpStatus, Post, UseFilters } from '@nestjs/common';
import { ResponseUtil } from '@nest-cloud/common';
import { ContentCompareExceptionFilter } from './content-compare.filter';
import { ContentCompareService } from './content-compare.service';
import { CompareContentDto } from './dto/compare-content.dto';

@Controller('api/content-compare')
@UseFilters(ContentCompareExceptionFilter)
export class ContentCompareController {
  constructor(private readonly compareService: ContentCompareService) {}

  /** 接收两份 JSON 原文并返回规范化差异。 */
  @Post('json')
  @HttpCode(HttpStatus.OK)
  async compareJson(@Body() body: CompareContentDto) {
    const result = await this.compareService.compare({
      format: 'json',
      left: body.left,
      right: body.right,
    });
    return ResponseUtil.success(result);
  }

  /** 接收两份 ENV 原文并返回保留原文的差异。 */
  @Post('env')
  @HttpCode(HttpStatus.OK)
  async compareEnv(@Body() body: CompareContentDto) {
    const result = await this.compareService.compare({
      format: 'env',
      left: body.left,
      right: body.right,
    });
    return ResponseUtil.success(result);
  }
}
