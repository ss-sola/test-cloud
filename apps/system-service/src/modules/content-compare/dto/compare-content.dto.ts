import { Transform } from 'class-transformer';
import { IsString, MaxLength } from 'class-validator';
import { CONTENT_COMPARE_LIMITS } from '../../../constants/content-compare.constants';

/**
 * 原样读取请求体字段，避免全局 enableImplicitConversion 把数字、数组等值转成字符串后绕过 IsString。
 */
const rawValue = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key];

export class CompareContentDto {
  @Transform(rawValue)
  @IsString()
  @MaxLength(CONTENT_COMPARE_LIMITS.maxTextLength)
  left!: string;

  @Transform(rawValue)
  @IsString()
  @MaxLength(CONTENT_COMPARE_LIMITS.maxTextLength)
  right!: string;
}
