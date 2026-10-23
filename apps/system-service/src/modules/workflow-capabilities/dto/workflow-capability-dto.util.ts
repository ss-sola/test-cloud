import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
} from 'class-validator';
import type { ValidatorConstraintInterface } from 'class-validator';
import { WORKFLOW_CAPABILITY_LIMITS } from '../../../constants/workflow-capability.constants';

/** 原样读取请求体字段，避免全局隐式转换把数字、数组等值转成字符串后绕过 IsString。 */
export const rawValue = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key];

interface RawTextOptions {
  max: number;
  min?: number;
  pattern?: RegExp;
  optional?: boolean;
}

/** 受约束的原始字符串字段：类型、长度和可选字符集；optional 时允许缺省或 null。 */
export function RawText(options: RawTextOptions) {
  return applyDecorators(
    Transform(rawValue),
    ...(options.optional ? [IsOptional()] : []),
    IsString(),
    MinLength(options.min ?? 0),
    MaxLength(options.max),
    ...(options.pattern ? [Matches(options.pattern)] : []),
  );
}

/** 有界矩形二维单元格矩阵：元素只能是字符串、有限数字、布尔或 null。 */
@ValidatorConstraint({ name: 'cellMatrix', async: false })
class CellMatrixConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    const limits = WORKFLOW_CAPABILITY_LIMITS;
    if (!Array.isArray(value) || value.length < 1 || value.length > limits.feishuMaxWriteRows) {
      return false;
    }
    const width = Array.isArray(value[0]) ? value[0].length : 0;
    if (width < 1 || width > limits.feishuMaxWriteColumns) return false;
    if (value.length * width > limits.feishuMaxWriteCells) return false;

    let bytes = 0;
    for (const row of value) {
      if (!Array.isArray(row) || row.length !== width) return false;
      for (const cell of row) {
        if (typeof cell === 'string') {
          if (cell.length > limits.feishuMaxCellChars) return false;
          bytes += Buffer.byteLength(cell, 'utf8');
        } else if (typeof cell === 'number') {
          if (!Number.isFinite(cell)) return false;
          bytes += 24;
        } else if (cell === null || typeof cell === 'boolean') {
          bytes += 5;
        } else {
          return false;
        }
      }
      if (bytes > limits.feishuMaxMatrixBytes) return false;
    }
    return true;
  }

  defaultMessage(): string {
    return 'values 必须是有界的矩形二维数组';
  }
}

export const IsCellMatrix = () => Validate(CellMatrixConstraint);
