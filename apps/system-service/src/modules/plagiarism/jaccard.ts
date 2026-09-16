/** 计算两个 N-gram 集合的 Jaccard 相似度。 */
export function calculateJaccard(source: Set<string>, target: Set<string>): number {
  if (source.size === 0 && target.size === 0) return 0;
  let intersection = 0;
  for (const gram of source) {
    if (target.has(gram)) intersection += 1;
  }
  const union = source.size + target.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
