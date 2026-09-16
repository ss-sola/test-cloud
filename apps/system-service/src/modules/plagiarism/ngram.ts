/** 生成去重后的字符 N-gram 集合。 */
export function createNGrams(text: string, size: number): Set<string> {
  const characters = [...text];
  const grams = new Set<string>();
  if (size <= 0 || characters.length < size) return grams;
  for (let index = 0; index <= characters.length - size; index += 1) {
    grams.add(characters.slice(index, index + size).join(''));
  }
  return grams;
}

/** 将 N-gram 集合转换为稳定的可展示统计。 */
export function summarizeNGrams(source: Set<string>, target: Set<string>) {
  const common = [...source].filter((gram) => target.has(gram));
  return {
    sourceCount: source.size,
    targetCount: target.size,
    commonCount: common.length,
    commonPreview: common.slice(0, 12),
  };
}
