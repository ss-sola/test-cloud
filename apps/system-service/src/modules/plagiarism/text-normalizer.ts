import type { NormalizedPosition, NormalizedText, NormalizedUnit } from './plagiarism.types';

const CONTENT_CHARACTER = /[\p{L}\p{N}\p{Script=Han}]/u;
const LATIN_CHARACTER = /\p{Script=Latin}/u;
const HTML_TAG = /<\/?[A-Za-z][^>]*>|<!--[\s\S]*?-->|<![A-Z][^>]*>/g;
const WORD_APOSTROPHE = /['’]/u;

/** 清洗文本并保留规范化字符到原文的区间映射及统计单位边界。 */
export function normalizeText(input: string): NormalizedText {
  const value: string[] = [];
  const positions: NormalizedPosition[] = [];
  const units: NormalizedUnit[] = [];
  const tagRanges = [...input.matchAll(HTML_TAG)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  let originalOffset = 0;
  let tagIndex = 0;
  let activeWord: NormalizedUnit | undefined;
  let pendingApostrophe = false;

  for (const character of input) {
    const start = originalOffset;
    originalOffset += character.length;
    while (tagIndex < tagRanges.length && start >= tagRanges[tagIndex].end) tagIndex += 1;
    const activeTag = tagRanges[tagIndex];
    if (activeTag && start >= activeTag.start && start < activeTag.end) {
      activeWord = undefined;
      pendingApostrophe = false;
      continue;
    }

    const normalized = character.normalize('NFKC').toLocaleLowerCase();
    const normalizedCharacters = [...normalized];
    const contentCharacters = normalizedCharacters.filter((item) => CONTENT_CHARACTER.test(item));
    if (contentCharacters.length === 0) {
      if (activeWord && WORD_APOSTROPHE.test(character)) {
        pendingApostrophe = true;
      } else {
        activeWord = undefined;
        pendingApostrophe = false;
      }
      continue;
    }

    for (const normalizedCharacter of contentCharacters) {
      const normalizedIndex = value.length;
      value.push(normalizedCharacter);
      positions.push({ start, end: originalOffset });
      if (LATIN_CHARACTER.test(normalizedCharacter)) {
        if (!activeWord || (!pendingApostrophe && activeWord.end !== normalizedIndex)) {
          activeWord = { start: normalizedIndex, end: normalizedIndex + 1, kind: 'word' };
          units.push(activeWord);
        } else {
          activeWord.end = normalizedIndex + 1;
        }
        pendingApostrophe = false;
        continue;
      }

      activeWord = undefined;
      pendingApostrophe = false;
      units.push({ start: normalizedIndex, end: normalizedIndex + 1, kind: 'character' });
    }
  }

  return { value: value.join(''), positions, units };
}

/** 将规范化文本区间映射回输入文本的 UTF-16 下标。 */
export function mapNormalizedRange(
  normalized: NormalizedText,
  start: number,
  end: number,
): NormalizedPosition {
  if (start < 0 || end <= start || start >= normalized.positions.length) {
    return { start: 0, end: 0 };
  }
  const first = normalized.positions[start];
  const last = normalized.positions[Math.min(end, normalized.positions.length) - 1];
  return { start: first.start, end: last.end };
}

/** 将输入拆成可用于诊断的纯文本长度信息。 */
export function getNormalizedPreview(input: string): {
  normalized: string;
  removedCharacters: number;
} {
  const normalized = normalizeText(input).value;
  return {
    normalized,
    removedCharacters: [...input].length - [...normalized].length,
  };
}

/** 删除 HTML 标签，保留该规则供测试和后续文本策略复用。 */
export function stripHtmlTags(input: string): string {
  return input.replace(HTML_TAG, '');
}
