import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ConfigFilePreviewTagsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  repositoryUrl!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  githubToken!: string;
}
