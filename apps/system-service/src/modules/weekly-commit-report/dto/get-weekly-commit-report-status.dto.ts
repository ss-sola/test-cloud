import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class GetWeeklyCommitReportStatusDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]*$/)
  jobId!: string;
}
