import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ResponseUtil } from '@nest-cloud/common';
import { RELEASE_AUTOMATION_IDEMPOTENCY_HEADER } from './release-automation.constants';
import { ReleaseAutomationJobService } from './release-automation-job.service';
import { ReleaseAutomationSyncService } from './release-automation-sync.service';
import type { ReleaseMode, ReleasePlanInput } from './release-automation.types';
import {
  CreateReleaseAutomationJobDto,
  GetReleaseAutomationStatusDto,
} from './dto/release-automation.dto';

@Controller('api/release-automation')
export class ReleaseAutomationController {
  constructor(
    private readonly jobService: ReleaseAutomationJobService,
    private readonly syncService: ReleaseAutomationSyncService,
  ) {}

  @Post('jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  async createJob(
    @Body() body: CreateReleaseAutomationJobDto,
    @Headers(RELEASE_AUTOMATION_IDEMPOTENCY_HEADER) idempotencyKey?: string,
  ) {
    return ResponseUtil.success(
      await this.jobService.create({
        idempotencyKey: idempotencyKey ?? '',
        plan: this.toPlan(body, 'apply'),
      }),
      'queued',
      HttpStatus.ACCEPTED,
    );
  }

  @Post('test/execute')
  @HttpCode(HttpStatus.OK)
  async executeTest(
    @Body() body: CreateReleaseAutomationJobDto,
    @Headers(RELEASE_AUTOMATION_IDEMPOTENCY_HEADER) idempotencyKey?: string,
  ) {
    return ResponseUtil.success(
      await this.syncService.execute({
        idempotencyKey: idempotencyKey ?? '',
        plan: this.toPlan(body, 'dry-run'),
      }),
      'executed',
      HttpStatus.OK,
    );
  }

  @Get('jobs/status')
  async getStatus(@Query() query: GetReleaseAutomationStatusDto) {
    return ResponseUtil.success(await this.jobService.getStatus(query.jobId));
  }

  private toPlan(body: CreateReleaseAutomationJobDto, defaultMode: ReleaseMode): ReleasePlanInput {
    return {
      repository: body.repository,
      targetBranch: body.targetBranch,
      gitTag: body.gitTag,
      mode: body.mode ?? defaultMode,
      pageConfig: {
        gitAddress: body.gitAddress,
        branch: body.branch,
        githubToken: body.githubToken ?? '',
        jenkinsToken: body.jenkinsToken ?? '',
        jenkinsBaseUrl: body.jenkinsBaseUrl ?? '',
        feishuAppId: body.feishuAppId ?? '',
        feishuAppSecret: body.feishuAppSecret ?? '',
      },
      selectedTasks: body.tasks,
    };
  }
}
