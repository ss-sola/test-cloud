import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ResponseUtil } from '@nest-cloud/common';
import { ComparePlagiarismDto } from './dto/compare-plagiarism.dto';
import { PlagiarismService } from './plagiarism.service';

@Controller('api/plagiarism')
export class PlagiarismController {
  constructor(private readonly plagiarismService: PlagiarismService) {}

  /** 接收两篇短文本并返回完整的可解释查重步骤。 */
  @Post('compare')
  @HttpCode(HttpStatus.OK)
  compare(@Body() body: ComparePlagiarismDto) {
    return ResponseUtil.success(
      this.plagiarismService.compare({
        source: body.source,
        target: body.target,
        threshold: body.threshold,
        editDistance: body.editDistance,
      }),
    );
  }
}
