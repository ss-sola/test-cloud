import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ResponseUtil } from '@nest-cloud/common';
import type { Request, Response } from 'express';
import {
  WorkflowConfirmDto,
  WorkflowEventsQueryDto,
  WorkflowRunDto,
  WorkflowStatusQueryDto,
  WorkflowStopDto,
} from './dto/workflow-execution.dto';
import { WorkflowExecutionHttpService } from './workflow-execution-http.service';
import { WorkflowExecutionExceptionFilter } from './workflow-execution.filter';
import { WorkflowExecutionService } from './workflow-execution.service';

@Controller('api/workflow')
@UseFilters(WorkflowExecutionExceptionFilter)
export class WorkflowExecutionController {
  constructor(
    private readonly executionService: WorkflowExecutionService,
    private readonly httpService: WorkflowExecutionHttpService,
  ) {}

  /** 启动一次执行，返回任务标识、访问 token 与过期时间。 */
  @Post('run')
  @HttpCode(HttpStatus.OK)
  async run(@Body() body: WorkflowRunDto) {
    return ResponseUtil.success(await this.executionService.start(body));
  }

  /** 查询任务快照；带 nodeId 时包含该节点的完整输出。 */
  @Get('status')
  async status(@Query() query: WorkflowStatusQueryDto, @Req() req: Request) {
    const token = this.httpService.takeAccessToken(req);
    return ResponseUtil.success(await this.executionService.status(query, token));
  }

  /** 以 SSE 推送任务快照与增量；断开连接只退订，不停止任务。 */
  @Get('events')
  events(@Query() query: WorkflowEventsQueryDto, @Req() req: Request, @Res() res: Response): void {
    const token = this.httpService.takeAccessToken(req);
    this.httpService.openEventStream(res, (listener) =>
      this.executionService.subscribe(query.runId, token, listener),
    );
  }

  /** 显式停止任务。 */
  @Post('stop')
  @HttpCode(HttpStatus.OK)
  async stop(@Body() body: WorkflowStopDto, @Req() req: Request) {
    const token = this.httpService.takeAccessToken(req);
    return ResponseUtil.success(await this.executionService.stop(body.runId, token));
  }

  /** 接受或拒绝一次待确认的写入。 */
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(@Body() body: WorkflowConfirmDto, @Req() req: Request) {
    const token = this.httpService.takeAccessToken(req);
    return ResponseUtil.success(await this.executionService.confirm(body, token));
  }
}
