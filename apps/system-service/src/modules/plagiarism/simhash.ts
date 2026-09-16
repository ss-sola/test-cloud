const MASK_64 = (1n << 64n) - 1n;

/** 使用 FNV-1a 生成稳定的 64 位 N-gram 哈希。 */
export function hashGram(gram: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const character of gram) {
    for (const byte of Buffer.from(character, 'utf8')) {
      hash ^= BigInt(byte);
      hash = (hash * 0x100000001b3n) & MASK_64;
    }
  }
  return hash;
}

/** 根据 N-gram 集合生成 64 位 SimHash。 */
export function calculateSimHash(grams: Set<string>, bits = 64): bigint {
  if (grams.size === 0) return 0n;
  const vector = Array.from({ length: bits }, () => 0);
  for (const gram of grams) {
    const hash = hashGram(gram);
    for (let bit = 0; bit < bits; bit += 1) {
      vector[bit] += (hash & (1n << BigInt(bit))) !== 0n ? 1 : -1;
    }
  }

  return vector.reduce(
    (result, value, bit) => (value >= 0 ? result | (1n << BigInt(bit)) : result),
    0n,
  );
}

/** 计算两个 64 位 SimHash 的汉明距离。 */
export function calculateHammingDistance(source: bigint, target: bigint, bits = 64): number {
  let value = (source ^ target) & ((1n << BigInt(bits)) - 1n);
  let distance = 0;
  while (value > 0n) {
    value &= value - 1n;
    distance += 1;
  }
  return distance;
}

/** 将汉明距离转换为 0 到 1 的相似度。 */
export function calculateSimHashSimilarity(source: bigint, target: bigint, bits = 64): number {
  return 1 - calculateHammingDistance(source, target, bits) / bits;
}

export function formatSimHash(value: bigint): string {
  return `0x${value.toString(16).padStart(16, '0')}`;
}
