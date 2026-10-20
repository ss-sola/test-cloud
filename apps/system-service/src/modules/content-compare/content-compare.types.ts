export type CompareFormat = 'json' | 'env';
export type DiffStatus = 'added' | 'removed' | 'modified' | 'unchanged';
export type CompareSide = 'left' | 'right';
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CompareContentInput {
  format: CompareFormat;
  left: string;
  right: string;
}

export interface CompareParseError {
  code: string;
  message: string;
  line?: number;
  column?: number;
  previousLine?: number;
}

export interface CompareInputErrors {
  left: CompareParseError[];
  right: CompareParseError[];
}

export interface DiffSegment {
  text: string;
  status: Exclude<DiffStatus, 'unchanged'> | null;
}

export interface ContentDiffNode {
  key: string | number;
  path: string;
  hasLeft: boolean;
  hasRight: boolean;
  type: 'object' | 'array' | 'value';
  status: DiffStatus;
  leftDisplay: string;
  rightDisplay: string;
  children: ContentDiffNode[];
}

export interface ContentCompareResult {
  leftText: string;
  rightText: string;
  stats: { added: number; removed: number; modified: number };
  tree: ContentDiffNode;
  segments: { left: DiffSegment[]; right: DiffSegment[] };
}
