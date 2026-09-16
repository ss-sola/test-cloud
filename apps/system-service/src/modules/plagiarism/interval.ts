import type { RawPlagiarismMatch } from './plagiarism.types';

/** 合并同一对文本中相邻或重叠的重复区间。 */
export function mergeMatches(matches: RawPlagiarismMatch[]): RawPlagiarismMatch[] {
  const ordered = [...matches].sort(
    (left, right) => left.sourceStart - right.sourceStart || left.targetStart - right.targetStart,
  );
  const merged: RawPlagiarismMatch[] = [];

  for (const match of ordered) {
    const previous = merged.at(-1);
    const sourceOverlap =
      previous && match.sourceStart < previous.sourceEnd && match.sourceEnd > previous.sourceStart;
    const targetOverlap =
      previous && match.targetStart < previous.targetEnd && match.targetEnd > previous.targetStart;
    const forwardAdjacent =
      previous &&
      match.sourceStart === previous.sourceEnd &&
      match.targetStart === previous.targetEnd;
    const sameBlock =
      previous &&
      previous.sourceBlock === match.sourceBlock &&
      previous.targetBlock === match.targetBlock;
    if (previous && sameBlock && ((sourceOverlap && targetOverlap) || forwardAdjacent)) {
      previous.sourceEnd = Math.max(previous.sourceEnd, match.sourceEnd);
      previous.targetEnd = Math.max(previous.targetEnd, match.targetEnd);
      previous.length = previous.sourceEnd - previous.sourceStart;
      continue;
    }
    merged.push({ ...match });
  }

  return merged;
}

/** 根据不重叠区间计算去重后的字符数。 */
export function calculateDuplicateLength(matches: RawPlagiarismMatch[]): number {
  return matches.reduce((total, match) => total + match.length, 0);
}
