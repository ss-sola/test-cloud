import type { DailyReportSection } from '../../modules/weekly-commit-report/weekly-report.types';

export interface FeishuApiResponse<T = unknown> {
  code?: number;
  msg?: string;
  data?: T;
}

export interface FeishuWikiNode {
  obj_type?: string;
  obj_token?: string;
  title?: string;
}

export interface FeishuSheetInfo {
  sheet_id?: string;
  title?: string;
  row_count?: number;
  column_count?: number;
}

export interface FeishuValueRange {
  range?: string;
  values?: unknown[][];
}

export interface FeishuRequestContext {
  appId: string;
  appSecret: string;
  requestTimeoutMs: number;
  maxRetries: number;
}

export interface FeishuPublishSettings extends FeishuRequestContext {
  enabled: boolean;
  wikiUrl: string;
  name?: string;
}

export interface FeishuPublishTargetInput {
  person?: string;
}

export interface FeishuPublicationValues {
  sections: DailyReportSection[];
  row: number;
  range: string;
  values: string[];
}
