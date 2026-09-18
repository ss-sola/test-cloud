export interface PlagiarismCompareInput {
  source: string;
  target: string;
  threshold?: number;
  editDistance?: number;
}

export type PlagiarismCountingMode = 'character' | 'word' | 'mixed';

export type NormalizedUnitKind = 'character' | 'word';

export interface NormalizedPosition {
  start: number;
  end: number;
}

export interface NormalizedUnit {
  start: number;
  end: number;
  kind: NormalizedUnitKind;
}

export interface NormalizedText {
  value: string;
  positions: NormalizedPosition[];
  units: NormalizedUnit[];
}

export interface TextBlock {
  index: number;
  normalizedStart: number;
  normalizedEnd: number;
  originalStart: number;
  originalEnd: number;
  text: string;
}

export interface BlockComparison {
  sourceBlock: number;
  targetBlock: number;
  sourceLength: number;
  targetLength: number;
  sourceText: string;
  targetText: string;
  commonNGramCount: number;
  similarity: number;
}

export interface PlagiarismMatch {
  sourceStart: number;
  sourceEnd: number;
  targetStart: number;
  targetEnd: number;
  text: string;
  length: number;
  sourceContext: string;
  targetContext: string;
  sourceDensity: number;
  targetDensity: number;
  density: number;
  lengthScore: number;
  densityScore: number;
  score: number;
  counted: boolean;
  similarity: number;
  sourceUnitCount?: number;
  targetUnitCount?: number;
}

export interface PlagiarismStep {
  key: string;
  label: string;
  similarity?: number;
  data: Record<string, unknown>;
}

export interface PlagiarismDirectionResult {
  similarity: number;
  duplicateRate: number;
  duplicateLength: number;
  sourceLength: number;
  targetLength: number;
  duplicateUnitCount: number;
  sourceUnitCount: number;
  targetUnitCount: number;
  countingMode: PlagiarismCountingMode;
  threshold: number;
  editDistance: number;
  matches: PlagiarismMatch[];
  steps: PlagiarismStep[];
}

export interface PlagiarismResult extends PlagiarismDirectionResult {
  overallSimilarity: number;
  sourceToTarget: PlagiarismDirectionResult;
  targetToSource: PlagiarismDirectionResult;
}

export interface RawPlagiarismMatch {
  sourceStart: number;
  sourceEnd: number;
  targetStart: number;
  targetEnd: number;
  length: number;
  sourceBlock?: number;
  targetBlock?: number;
  blockSimilarity?: number;
  sourceBlockLength?: number;
  targetBlockLength?: number;
}
