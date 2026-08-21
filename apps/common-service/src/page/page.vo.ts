import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
export class PageCommon {
  @IsNumber()
  @Min(1)
  @IsOptional()
  pageNum: number = 1; // 当前多少页

  @IsNumber()
  @IsOptional()
  pageSize: number = 200; // 每页多少条

  @IsString()
  @IsOptional()
  search?: string;
}
