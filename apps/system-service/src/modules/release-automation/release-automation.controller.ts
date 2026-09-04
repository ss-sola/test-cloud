import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ResponseUtil } from '@nest-cloud/common';
import { RELEASE_AUTOMATION_IDEMPOTENCY_HEADER } from './release-automation.constants';
import { ReleaseAutomationJobService } from './release-automation-job.service';
import {
  CreateReleaseAutomationJobDto,
  GetReleaseAutomationStatusDto,
} from './dto/release-automation.dto';

@Controller('api/release-automation')
export class ReleaseAutomationController {
  constructor(private readonly jobService: ReleaseAutomationJobService) {}

  @Post('jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  async createJob(
    @Body() body: CreateReleaseAutomationJobDto,
    @Headers(RELEASE_AUTOMATION_IDEMPOTENCY_HEADER) idempotencyKey?: string,
  ) {
    return ResponseUtil.success(
      await this.jobService.create({
        idempotencyKey: idempotencyKey ?? '',
        plan: {
          repository: body.repository,
          targetBranch: body.targetBranch,
          candidateSha: body.candidateSha,
          version: body.version,
          mode: body.mode,
        },
      }),
      'queued',
      HttpStatus.ACCEPTED,
    );
  }

  @Get('jobs/status')
  async getStatus(@Query() query: GetReleaseAutomationStatusDto) {
    return ResponseUtil.success(await this.jobService.getStatus(query.jobId));
  }
}
