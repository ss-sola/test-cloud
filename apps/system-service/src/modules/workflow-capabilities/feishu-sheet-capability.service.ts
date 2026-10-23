import { Injectable } from '@nestjs/common';
import { FeishuSheetGatewayService } from '../../client/feishu/feishu-sheet-gateway.service';
import { WORKFLOW_CAPABILITY_LIMITS } from '../../constants/workflow-capability.constants';
import type { FeishuFindRowDto, FeishuWriteCellsDto } from './dto/feishu-sheet.dto';
import {
  assertMatrixMatchesRange,
  fillMergedCells,
  findUniqueRow,
  matrixAlreadyWritten,
  parseA1Range,
  toWritableCell,
} from './feishu-sheet-range.util';
import { WorkflowCapabilityException } from './workflow-capability.exception';

export interface FeishuFoundRow {
  wikiUrl: string;
  row: number;
  sheetId: string;
}

export interface FeishuWriteResult {
  range: string;
  updatedCells: number;
  status: 'written' | 'skipped';
}

/** 飞书表格查找与写入能力：范围、矩阵与确认都来自本次请求，不包含周报业务规则。 */
@Injectable()
export class FeishuSheetCapabilityService {
  constructor(private readonly gateway: FeishuSheetGatewayService) {}

  /** 在用户指定的范围内按列条件查找唯一行，合并单元格按区域取值，只读不写。 */
  async findRow(input: FeishuFindRowDto, signal: AbortSignal): Promise<FeishuFoundRow> {
    const range = parseA1Range(input.range, {
      maxRows: WORKFLOW_CAPABILITY_LIMITS.feishuMaxReadRows,
      maxColumns: WORKFLOW_CAPABILITY_LIMITS.feishuMaxReadColumns,
      maxCells: WORKFLOW_CAPABILITY_LIMITS.feishuMaxReadCells,
    });
    const deadline = this.withDeadline(signal);
    const target = await this.gateway.resolveTarget({
      wikiUrl: input.wikiUrl,
      appId: input.runtime.appId,
      appSecret: input.runtime.appSecret,
      signal: deadline,
    });
    const values = await this.gateway.readValues(target, input.range, deadline);
    const merges = await this.gateway.readMerges(target, deadline);
    const row = findUniqueRow(fillMergedCells(values, range, merges), range, input.matches);
    return { wikiUrl: input.wikiUrl.trim(), row, sheetId: target.sheetId };
  }

  /** 在已确认的明确范围内写入矩阵：内容已相同则跳过，否则只发送一次写请求。 */
  async writeCells(input: FeishuWriteCellsDto, signal: AbortSignal): Promise<FeishuWriteResult> {
    const range = parseA1Range(input.range, {
      maxRows: WORKFLOW_CAPABILITY_LIMITS.feishuMaxWriteRows,
      maxColumns: WORKFLOW_CAPABILITY_LIMITS.feishuMaxWriteColumns,
      maxCells: WORKFLOW_CAPABILITY_LIMITS.feishuMaxWriteCells,
    });
    assertMatrixMatchesRange(input.values, range);
    const cells = input.values.length * input.values[0].length;

    const deadline = this.withDeadline(signal);
    const target = await this.gateway.resolveTarget({
      wikiUrl: input.wikiUrl,
      appId: input.runtime.appId,
      appSecret: input.runtime.appSecret,
      signal: deadline,
    });
    const current = await this.gateway.readValues(target, input.range, deadline);
    if (matrixAlreadyWritten(current, input.values)) {
      return { range: input.range, updatedCells: 0, status: 'skipped' };
    }
    // 写请求发出前再次确认调用方仍在等待；发出后只能停止等待，无法撤销
    if (deadline.aborted) throw new WorkflowCapabilityException('请求已取消，未发送写入。', 499);

    try {
      await this.gateway.writeValues({
        target,
        range: input.range,
        values: input.values.map((row) => row.map(toWritableCell)),
        signal: deadline,
      });
    } catch (error) {
      if (error instanceof WorkflowCapabilityException && [499, 504].includes(error.getStatus())) {
        throw new WorkflowCapabilityException(
          '写入请求已中断或超时，飞书可能已写入，请核对表格后再决定是否重试。',
          error.getStatus(),
        );
      }
      throw error;
    }
    return { range: input.range, updatedCells: cells, status: 'written' };
  }

  private withDeadline(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([
      signal,
      AbortSignal.timeout(WORKFLOW_CAPABILITY_LIMITS.feishuTotalTimeoutMs),
    ]);
  }
}
