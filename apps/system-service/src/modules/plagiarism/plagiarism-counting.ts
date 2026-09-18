import type {
  NormalizedText,
  NormalizedUnit,
  PlagiarismCountingMode,
  RawPlagiarismMatch,
} from './plagiarism.types';

/** 根据规范化单位确定当前文本的统计模式。 */
export function resolveCountingMode(normalized: NormalizedText): PlagiarismCountingMode {
  const hasWords = normalized.units.some((unit) => unit.kind === 'word');
  const hasCharacters = normalized.units.some((unit) => unit.kind === 'character');
  if (hasWords && hasCharacters) return 'mixed';
  return hasWords ? 'word' : 'character';
}

/** 统计规范化文本中的字、词或其他内容单位。 */
export function countNormalizedUnits(normalized: NormalizedText): number {
  return normalized.units.length;
}

/** 统计重复区间内完整覆盖的计数单位，区间使用规范化 code-point 下标。 */
export function countUnitsInRange(normalized: NormalizedText, start: number, end: number): number {
  return normalized.units.filter((unit) => unit.start >= start && unit.end <= end).length;
}

/** 将字符级候选裁剪到完整英文词边界，避免半词进入高亮和重复统计。 */
export function alignMatchToCompleteUnits(
  candidate: RawPlagiarismMatch,
  source: NormalizedText,
  target: NormalizedText,
): RawPlagiarismMatch | null {
  const sourceUnits = getContainedUnits(source.units, candidate.sourceStart, candidate.sourceEnd);
  const targetUnits = getContainedUnits(target.units, candidate.targetStart, candidate.targetEnd);
  const hasWordBoundary =
    hasOverlappingWord(source.units, candidate.sourceStart, candidate.sourceEnd) ||
    hasOverlappingWord(target.units, candidate.targetStart, candidate.targetEnd);
  if (!hasWordBoundary) return candidate;
  if (sourceUnits.length === 0 || targetUnits.length === 0) return null;

  const alignedCount = Math.min(sourceUnits.length, targetUnits.length);
  const alignedSourceUnits = sourceUnits.slice(0, alignedCount);
  const alignedTargetUnits = targetUnits.slice(0, alignedCount);
  if (
    sourceUnits.length !== targetUnits.length &&
    !sameUnit(alignedSourceUnits[0], alignedTargetUnits[0], source, target)
  ) {
    return null;
  }
  if (alignedSourceUnits.some((unit, index) => unit.kind !== alignedTargetUnits[index].kind)) {
    return null;
  }

  const sourceStart = alignedSourceUnits[0].start;
  const sourceEnd = alignedSourceUnits.at(-1)!.end;
  const targetStart = alignedTargetUnits[0].start;
  const targetEnd = alignedTargetUnits.at(-1)!.end;
  return {
    ...candidate,
    sourceStart,
    sourceEnd,
    targetStart,
    targetEnd,
    length: sourceEnd - sourceStart,
  };
}

function getContainedUnits(units: NormalizedUnit[], start: number, end: number): NormalizedUnit[] {
  return units.filter((unit) => unit.start >= start && unit.end <= end);
}

function hasOverlappingWord(units: NormalizedUnit[], start: number, end: number): boolean {
  return units.some((unit) => unit.kind === 'word' && unit.start < end && unit.end > start);
}

function sameUnit(
  source: NormalizedUnit,
  target: NormalizedUnit,
  sourceText: NormalizedText,
  targetText: NormalizedText,
): boolean {
  return (
    source.kind === target.kind &&
    sourceText.value.slice(source.start, source.end) ===
      targetText.value.slice(target.start, target.end)
  );
}
