import type { RawPlagiarismMatch } from './plagiarism.types';

export interface MatchContext {
  sourceContextStart: number;
  sourceContextEnd: number;
  targetContextStart: number;
  targetContextEnd: number;
  sourceContext: string;
  targetContext: string;
}

export interface DensityResult {
  sourceDensity: number;
  targetDensity: number;
  density: number;
}

export interface MatchValidation extends DensityResult {
  lengthScore: number;
  densityScore: number;
  score: number;
  counted: boolean;
}

/** 获取重复区间两侧的上下文，供评分和前端解释使用。 */
export function expandContext(
  source: string,
  target: string,
  match: RawPlagiarismMatch,
  before: number,
  after: number,
): MatchContext {
  const sourceCharacters = [...source];
  const targetCharacters = [...target];
  const sourceContextStart = Math.max(0, match.sourceStart - before);
  const sourceContextEnd = Math.min(sourceCharacters.length, match.sourceEnd + after);
  const targetContextStart = Math.max(0, match.targetStart - before);
  const targetContextEnd = Math.min(targetCharacters.length, match.targetEnd + after);
  return {
    sourceContextStart,
    sourceContextEnd,
    targetContextStart,
    targetContextEnd,
    sourceContext: sourceCharacters.slice(sourceContextStart, sourceContextEnd).join(''),
    targetContext: targetCharacters.slice(targetContextStart, targetContextEnd).join(''),
  };
}

/** 用两侧较小密度计算保守的重复密度。 */
export function calculateDensity(match: RawPlagiarismMatch, context: MatchContext): DensityResult {
  const sourceLength = context.sourceContextEnd - context.sourceContextStart;
  const targetLength = context.targetContextEnd - context.targetContextStart;
  const sourceMatchLength = match.sourceEnd - match.sourceStart;
  const targetMatchLength = match.targetEnd - match.targetStart;
  const sourceDensity = sourceLength === 0 ? 0 : sourceMatchLength / sourceLength;
  const targetDensity = targetLength === 0 ? 0 : targetMatchLength / targetLength;
  return {
    sourceDensity,
    targetDensity,
    density: Math.min(sourceDensity, targetDensity),
  };
}

export function calculateLengthScore(length: number): number {
  if (length < 5) return 0;
  if (length < 10) return 0.3;
  if (length < 16) return 0.6;
  if (length < 30) return 0.85;
  return 1;
}

export function calculateDensityScore(density: number): number {
  if (density < 0.15) return 0;
  if (density < 0.25) return 0.3;
  if (density < 0.4) return 0.6;
  if (density < 0.6) return 0.8;
  return 1;
}

/** 将重复长度和双侧上下文密度合成为最终证据评分。 */
export function validateMatch(
  match: RawPlagiarismMatch,
  context: MatchContext,
  minScore: number,
  lengthScoreWeight: number,
  densityScoreWeight: number,
): MatchValidation {
  const density = calculateDensity(match, context);
  const matchLength = Math.min(
    match.sourceEnd - match.sourceStart,
    match.targetEnd - match.targetStart,
  );
  const lengthScore = calculateLengthScore(matchLength);
  const densityScore = calculateDensityScore(density.density);
  const score = lengthScore * lengthScoreWeight + densityScore * densityScoreWeight;
  return {
    ...density,
    lengthScore,
    densityScore,
    score,
    counted: score >= minScore,
  };
}
