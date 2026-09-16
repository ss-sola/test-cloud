import type { RawPlagiarismMatch } from './plagiarism.types';

/** 找出达到最小长度的最长公共连续子串候选。 */
export function findCommonSubstrings(
  source: string,
  target: string,
  minLength: number,
): RawPlagiarismMatch[] {
  const sourceCharacters = [...source];
  const targetCharacters = [...target];
  if (!sourceCharacters.length || !targetCharacters.length || minLength <= 0) return [];
  let previous = new Uint16Array(targetCharacters.length + 1);
  const candidates: RawPlagiarismMatch[] = [];

  for (let sourceIndex = 1; sourceIndex <= sourceCharacters.length; sourceIndex += 1) {
    const current = new Uint16Array(targetCharacters.length + 1);
    for (let targetIndex = 1; targetIndex <= targetCharacters.length; targetIndex += 1) {
      if (sourceCharacters[sourceIndex - 1] !== targetCharacters[targetIndex - 1]) continue;
      const length = previous[targetIndex - 1] + 1;
      current[targetIndex] = length;
      const reachesEnd =
        sourceIndex === sourceCharacters.length || targetIndex === targetCharacters.length;
      const nextDiffers =
        !reachesEnd && sourceCharacters[sourceIndex] !== targetCharacters[targetIndex];
      if (length >= minLength && (reachesEnd || nextDiffers)) {
        candidates.push({
          sourceStart: sourceIndex - length,
          sourceEnd: sourceIndex,
          targetStart: targetIndex - length,
          targetEnd: targetIndex,
          length,
        });
      }
    }
    previous = current;
  }

  return candidates.sort(
    (left, right) => right.length - left.length || left.sourceStart - right.sourceStart,
  );
}

/** 从候选锚点向前、向后扩展连续相同字符。 */
export function expandMatch(
  source: string,
  target: string,
  match: RawPlagiarismMatch,
): RawPlagiarismMatch {
  const sourceCharacters = [...source];
  const targetCharacters = [...target];
  let sourceStart = match.sourceStart;
  let sourceEnd = match.sourceEnd;
  let targetStart = match.targetStart;
  let targetEnd = match.targetEnd;
  while (
    sourceStart > 0 &&
    targetStart > 0 &&
    sourceCharacters[sourceStart - 1] === targetCharacters[targetStart - 1]
  ) {
    sourceStart -= 1;
    targetStart -= 1;
  }
  while (
    sourceEnd < sourceCharacters.length &&
    targetEnd < targetCharacters.length &&
    sourceCharacters[sourceEnd] === targetCharacters[targetEnd]
  ) {
    sourceEnd += 1;
    targetEnd += 1;
  }
  return {
    ...match,
    sourceStart,
    sourceEnd,
    targetStart,
    targetEnd,
    length: sourceEnd - sourceStart,
  };
}

/** 合并相邻且仅有少量插入、删除或替换的连续证据。 */
export function mergeApproximateMatches(
  matches: RawPlagiarismMatch[],
  source: string,
  target: string,
  maxGap = 2,
  maxEdits = 2,
): RawPlagiarismMatch[] {
  const ordered = [...matches].sort(
    (left, right) => left.sourceStart - right.sourceStart || left.targetStart - right.targetStart,
  );
  const merged: RawPlagiarismMatch[] = [];
  for (const match of ordered) {
    const previous = merged.at(-1);
    if (
      !previous ||
      match.sourceBlock !== previous.sourceBlock ||
      match.targetBlock !== previous.targetBlock
    ) {
      merged.push({ ...match });
      continue;
    }
    const sourceGap = match.sourceStart - previous.sourceEnd;
    const targetGap = match.targetStart - previous.targetEnd;
    if (
      sourceGap < 0 ||
      targetGap < 0 ||
      sourceGap > maxGap ||
      targetGap > maxGap ||
      !isWithinEditDistance(
        sliceCharacters(source, previous.sourceEnd, match.sourceStart),
        sliceCharacters(target, previous.targetEnd, match.targetStart),
        maxEdits,
      )
    ) {
      merged.push({ ...match });
      continue;
    }
    previous.sourceEnd = match.sourceEnd;
    previous.targetEnd = match.targetEnd;
    previous.length = previous.sourceEnd - previous.sourceStart;
  }
  return merged;
}

function sliceCharacters(text: string, start: number, end: number): string {
  return [...text].slice(start, end).join('');
}

function isWithinEditDistance(source: string, target: string, maxEdits: number): boolean {
  if (Math.max(source.length, target.length) <= maxEdits) return true;
  return editDistance(source, target) <= maxEdits;
}

function editDistance(source: string, target: string): number {
  const previous = Array.from({ length: target.length + 1 }, (_, index) => index);
  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    const current = [sourceIndex];
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      current[targetIndex] = Math.min(
        current[targetIndex - 1] + 1,
        previous[targetIndex] + 1,
        previous[targetIndex - 1] + (source[sourceIndex - 1] === target[targetIndex - 1] ? 0 : 1),
      );
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index];
  }
  return previous[target.length];
}

/** 合并双侧都相邻或重叠的跨分块重复证据。 */
export function mergeAdjacentMatches(
  matches: RawPlagiarismMatch[],
  maxSourceGap: number,
  maxTargetGap: number,
  minPartLength = 0,
): RawPlagiarismMatch[] {
  const ordered = [...matches].sort(
    (left, right) => left.sourceStart - right.sourceStart || left.targetStart - right.targetStart,
  );
  const merged: RawPlagiarismMatch[] = [];
  for (const match of ordered) {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push({ ...match });
      continue;
    }
    const sourceOverlap =
      match.sourceStart < previous.sourceEnd && match.sourceEnd > previous.sourceStart;
    const targetOverlap =
      match.targetStart < previous.targetEnd && match.targetEnd > previous.targetStart;
    const sourceGap = match.sourceStart - previous.sourceEnd;
    const targetGap = match.targetStart - previous.targetEnd;
    const eligibleParts = previous.length >= minPartLength && match.length >= minPartLength;
    const related =
      eligibleParts &&
      (sourceOverlap ||
        targetOverlap ||
        (sourceGap >= 0 &&
          targetGap >= 0 &&
          sourceGap <= maxSourceGap &&
          targetGap <= maxTargetGap));
    if (!related) {
      merged.push({ ...match });
      continue;
    }
    previous.sourceEnd = Math.max(previous.sourceEnd, match.sourceEnd);
    previous.targetEnd = Math.max(previous.targetEnd, match.targetEnd);
    previous.length = previous.sourceEnd - previous.sourceStart;
    previous.sourceBlock = undefined;
    previous.targetBlock = undefined;
    previous.sourceBlockLength = undefined;
    previous.targetBlockLength = undefined;
  }
  return merged;
}
export function selectNonOverlappingMatches(
  candidates: RawPlagiarismMatch[],
): RawPlagiarismMatch[] {
  const strategies = [
    [...candidates].sort(
      (left, right) => right.length - left.length || left.sourceStart - right.sourceStart,
    ),
    [...candidates].sort(
      (left, right) =>
        left.sourceStart - right.sourceStart ||
        left.targetStart - right.targetStart ||
        right.length - left.length,
    ),
    [...candidates].sort(
      (left, right) =>
        left.targetStart - right.targetStart ||
        left.sourceStart - right.sourceStart ||
        right.length - left.length,
    ),
  ];

  return (
    strategies
      .map((strategy) => selectGreedy(strategy))
      .sort(
        (left, right) =>
          sumLength(right) - sumLength(left) ||
          right.length - left.length ||
          (left[0]?.sourceStart ?? 0) - (right[0]?.sourceStart ?? 0),
      )
      .at(0) ?? []
  );
}

function selectGreedy(candidates: RawPlagiarismMatch[]): RawPlagiarismMatch[] {
  const selected: RawPlagiarismMatch[] = [];
  for (const candidate of candidates) {
    if (
      selected.some(
        (match) =>
          candidate.sourceStart < match.sourceEnd && candidate.sourceEnd > match.sourceStart,
      ) ||
      selected.some(
        (match) =>
          candidate.targetStart < match.targetEnd && candidate.targetEnd > match.targetStart,
      )
    ) {
      continue;
    }
    selected.push(candidate);
  }
  return selected.sort((left, right) => left.sourceStart - right.sourceStart);
}

function sumLength(matches: RawPlagiarismMatch[]): number {
  return matches.reduce((total, match) => total + match.length, 0);
}
