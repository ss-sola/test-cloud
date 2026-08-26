import { Body, Controller, Post } from '@nestjs/common';
import { ResponseUtil } from '@nest-cloud/common';
import { GenerateWeeklyCommitReportDto } from './dto/generate-weekly-commit-report.dto';
import { WeeklyCommitReportService } from './weekly-commit-report.service';

@Controller('api/weekly-commit-reports')
export class WeeklyCommitReportController {
  constructor(private readonly weeklyCommitReportService: WeeklyCommitReportService) {}

  @Post('generate')
  async generate(@Body() body: GenerateWeeklyCommitReportDto) {
    const result = await this.weeklyCommitReportService.generate({
      period: body.period,
      configs: body.configs,
    });
    return ResponseUtil.success(result);
  }
}
