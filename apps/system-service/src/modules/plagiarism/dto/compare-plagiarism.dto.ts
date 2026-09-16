import { Type } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PLAGIARISM_CONFIG } from '../plagiarism.constants';

export class ComparePlagiarismDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PLAGIARISM_CONFIG.maxTextLength)
  source!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(PLAGIARISM_CONFIG.maxTextLength)
  target!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(PLAGIARISM_CONFIG.minThreshold)
  @Max(PLAGIARISM_CONFIG.maxThreshold)
  threshold?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(PLAGIARISM_CONFIG.minEditDistance)
  editDistance?: number;
}
