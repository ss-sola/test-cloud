import type { NormalizedText, TextBlock } from './plagiarism.types';

const BLOCK_BOUNDARY = /[。！？!?；;：:，,\n\r.]/u;

/** 按句末标点和换行切分，保留原文位置的可比较文本块。 */
export function segmentText(
  input: string,
  normalized: NormalizedText,
  _minBlockLength: number,
): TextBlock[] {
  if (normalized.positions.length === 0) return [];
  const rawRanges: Array<{ start: number; end: number }> = [];
  let normalizedIndex = 0;
  let blockStart = 0;
  let offset = 0;

  for (const character of input) {
    offset += character.length;
    if (!BLOCK_BOUNDARY.test(character)) continue;
    while (
      normalizedIndex < normalized.positions.length &&
      normalized.positions[normalizedIndex].start < offset
    ) {
      normalizedIndex += 1;
    }
    if (normalizedIndex > blockStart) {
      rawRanges.push({ start: blockStart, end: normalizedIndex });
      blockStart = normalizedIndex;
    }
  }
  if (blockStart < normalized.positions.length) {
    rawRanges.push({ start: blockStart, end: normalized.positions.length });
  }

  return rawRanges.map((range, index) => {
    const first = normalized.positions[range.start];
    const last = normalized.positions[range.end - 1];
    return {
      index,
      normalizedStart: range.start,
      normalizedEnd: range.end,
      originalStart: first.start,
      originalEnd: last.end,
      text: [...normalized.value].slice(range.start, range.end).join(''),
    };
  });
}
