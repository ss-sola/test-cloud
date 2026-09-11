import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ConfigFilePreviewDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  repositoryUrl!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  branch!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  filePath!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  githubToken!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  tag?: string;
}
