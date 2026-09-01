import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ResponseUtil } from '@nest-cloud/common';
import { GenerateWeeklyCommitReportDto } from './dto/generate-weekly-commit-report.dto';
import { GetWeeklyCommitReportStatusDto } from './dto/get-weekly-commit-report-status.dto';
import { WeeklyCommitReportJobService } from './weekly-commit-report-job.service';
import { WeeklyCommitReportService } from './weekly-commit-report.service';

@Controller('api/weekly-commit-reports')
export class WeeklyCommitReportController {
  constructor(
    private readonly weeklyCommitReportService: WeeklyCommitReportService,
    private readonly jobService: WeeklyCommitReportJobService,
  ) {}

  @Post('jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  createJob(@Body() body: GenerateWeeklyCommitReportDto) {
    return ResponseUtil.success(
      this.jobService.create({ period: body.period, configs: body.configs, publish: body.publish }),
      'queued',
      HttpStatus.ACCEPTED,
    );
  }

  @Get('jobs/status')
  getJobStatus(@Query() query: GetWeeklyCommitReportStatusDto) {
    return ResponseUtil.success(this.jobService.getStatus(query.jobId));
  }

  @Post('generate')
  async generate(@Body() body: GenerateWeeklyCommitReportDto) {
    const result = await this.weeklyCommitReportService.generate({
      period: body.period,
      configs: body.configs,
    });
    return ResponseUtil.success(result);
  }
}
