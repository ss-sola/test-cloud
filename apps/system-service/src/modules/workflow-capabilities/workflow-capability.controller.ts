import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseFilters } from '@nestjs/common';
import { ResponseUtil } from '@nest-cloud/common';
import type { Request, Response } from 'express';
import { AiTextCapabilityService } from './ai-text-capability.service';
import { AiTextDto } from './dto/ai-text.dto';
import { FeishuFindRowDto, FeishuWriteCellsDto } from './dto/feishu-sheet.dto';
import { GithubCommitsDto } from './dto/github-commits.dto';
import { FeishuSheetCapabilityService } from './feishu-sheet-capability.service';
import { GithubCommitsCapabilityService } from './github-commits-capability.service';
import { WorkflowCapabilityHttpService } from './workflow-capability-http.service';
import { WorkflowCapabilityExceptionFilter } from './workflow-capability.filter';

@Controller('api/workflow-capabilities')
@UseFilters(WorkflowCapabilityExceptionFilter)
export class WorkflowCapabilityController {
  constructor(
    private readonly githubService: GithubCommitsCapabilityService,
    private readonly aiService: AiTextCapabilityService,
    private readonly feishuService: FeishuSheetCapabilityService,
    private readonly httpService: WorkflowCapabilityHttpService,
  ) {}

  /** 查询单个仓库的原始提交数组。 */
  @Post('github-commits')
  @HttpCode(HttpStatus.OK)
  async githubCommits(
    @Body() body: GithubCommitsDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const signal = this.httpService.createAbortSignal(req, res);
    return ResponseUtil.success(await this.githubService.query(body, signal));
  }

  /** 生成一段完整文本。 */
  @Post('ai-text')
  @HttpCode(HttpStatus.OK)
  async aiText(
    @Body() body: AiTextDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const signal = this.httpService.createAbortSignal(req, res);
    return ResponseUtil.success(await this.aiService.generate(body, signal));
  }

  /** 在指定范围内查找唯一行。 */
  @Post('feishu-find-row')
  @HttpCode(HttpStatus.OK)
  async feishuFindRow(
    @Body() body: FeishuFindRowDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const signal = this.httpService.createAbortSignal(req, res);
    return ResponseUtil.success(await this.feishuService.findRow(body, signal));
  }

  /** 向已确认的明确范围写入矩阵。 */
  @Post('feishu-write-cells')
  @HttpCode(HttpStatus.OK)
  async feishuWriteCells(
    @Body() body: FeishuWriteCellsDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const signal = this.httpService.createAbortSignal(req, res);
    return ResponseUtil.success(await this.feishuService.writeCells(body, signal));
  }
}
