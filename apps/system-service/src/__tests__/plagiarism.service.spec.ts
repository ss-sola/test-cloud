import { describe, expect, it } from 'vitest';
import { PLAGIARISM_CONFIG } from '../modules/plagiarism/plagiarism.constants';
import { PlagiarismService } from '../modules/plagiarism/plagiarism.service';

function createService() {
  return new PlagiarismService();
}

describe('PlagiarismService', () => {
  it('test.md case 1 returns full duplication for identical text', () => {
    const service = createService();
    const source = ' 这是一个重复片段测试内容。';
    const result = service.compare({ source, target: source, threshold: 0.6 });

    expect(result.similarity).toBeGreaterThan(0.5);
    expect(result.duplicateRate).toBe(1);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]).toMatchObject({
      sourceStart: 1,
      sourceEnd: source.length - 1,
      targetStart: 1,
      targetEnd: source.length - 1,
      similarity: expect.any(Number),
    });
    expect(result.steps.map((step) => step.key)).toEqual([
      'normalize',
      'segment',
      'ngram',
      'block-match',
      'jaccard',
      'simhash',
      'lcs',
      'threshold',
      'final',
    ]);
  });

  it('segments long sentences before matching and keeps block trace data', () => {
    const service = createService();
    const source = '这是第一段比较长的内容用于分句测试。这里是第二段比较长的内容用于分句测试。';
    const result = service.compare({ source, target: source, threshold: 0.6 });
    const segmentStep = result.steps.find((step) => step.key === 'segment');

    expect(segmentStep?.data).toMatchObject({ sourceBlockCount: 2, targetBlockCount: 2 });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.duplicateLength).toBe(result.sourceLength);
  });

  it('returns directional duplicate rates for asymmetric inputs', () => {
    const service = createService();
    const repeated = '人工智能正在快速改变现代教育的发展方式';
    const result = service.compare({
      source: `前面完全不同的内容。${repeated}`,
      target: repeated,
      threshold: 0.6,
    });

    expect(result.sourceToTarget.duplicateRate).toBeLessThan(1);
    expect(result.targetToSource.duplicateRate).toBe(1);
    expect(result.sourceToTarget.matches[0].text).toBe(repeated);
    expect(result.targetToSource.matches[0].text).toBe(repeated);
    expect(result.similarity).toBe(result.overallSimilarity);
    expect(result.overallSimilarity).toBe(
      Number(
        ((result.sourceToTarget.similarity + result.targetToSource.similarity) / 2).toFixed(6),
      ),
    );
  });

  it('does not infer high similarity when both short texts lack 3-gram features', () => {
    const service = createService();
    const result = service.compare({ source: '甲', target: '乙', threshold: 0 });

    expect(result.similarity).toBe(0);
    expect(result.duplicateRate).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it('keeps multiple non-overlapping matches when their order differs', () => {
    const service = createService();
    const result = service.compare({
      source: `${'a'.repeat(16)}${'b'.repeat(16)}`,
      target: `${'b'.repeat(16)}${'a'.repeat(16)}`,
      threshold: 0,
    });

    expect(result.duplicateLength).toBe(32);
    expect(result.matches).toHaveLength(2);
  });

  it('keeps ordinary angle-bracket text while removing valid HTML tags', () => {
    const service = createService();
    const result = service.compare({
      source: 'a < b 这是一个重复片段测试内容',
      target: 'a b这是一个重复片段测试内容',
      threshold: 0,
    });
    const tagged = service.compare({
      source: '<p>这是一个重复片段测试内容</p>',
      target: '这是一个重复片段测试内容',
      threshold: 0,
    });

    expect(result.matches.length).toBeGreaterThan(0);
    expect(tagged.matches.length).toBeGreaterThan(0);
  });

  it('normalizes full-width and case differences without losing original positions', () => {
    const service = createService();
    const result = service.compare({
      source: '前缀 ＡＢＣ：这是一个重复片段测试。',
      target: 'abc这是一个重复片段测试',
      threshold: 0,
    });

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].sourceStart).toBeGreaterThan(0);
    expect(result.matches[0].text).toContain('这是一个重复片段测试');
    expect(result.steps[0].data).toMatchObject({ sourceLength: expect.any(Number) });
  });

  it('keeps code-point matching aligned with UTF-16 source positions', () => {
    const service = createService();
    const source = '前缀𠀀𠀁𠀂𠀃𠀄𠀅𠀆𠀇𠀈';
    const target = '𠀀𠀁𠀂𠀃𠀄𠀅𠀆𠀇';
    const result = service.compare({ source, target, threshold: 0 });

    expect(result.matches[0]).toMatchObject({
      sourceStart: 2,
      targetStart: 0,
      length: 8,
      text: target,
    });
  });

  it('uses threshold to filter local matches while retaining candidate trace data', () => {
    const service = createService();
    const input = {
      source: '这是一个重复片段测试内容并且后面还有其他说明',
      target: '这是一个重复片段测试内容完全不同的文本',
    };
    const all = service.compare({ ...input, threshold: 0 });
    const strict = service.compare({ ...input, threshold: 1 });
    const lcsStep = strict.steps.find((step) => step.key === 'lcs');
    const thresholdStep = strict.steps.find((step) => step.key === 'threshold');

    expect(all.matches.length).toBeGreaterThan(0);
    expect(strict.matches).toHaveLength(0);
    expect(strict.duplicateRate).toBe(all.duplicateRate);
    expect(strict.similarity).toBe(all.similarity);
    expect(lcsStep?.data.candidateCount).toBeGreaterThan(0);
    expect(thresholdStep?.data).toMatchObject({ highlightedCount: 0 });
  });

  it('uses request editDistance to control approximate bridge merging', () => {
    const service = createService();
    const input = {
      source: '人工智能技术正在快速改变现代教育的发展方式。',
      target: '人工智能技术正在改变现代教育的发展方式。',
      threshold: 0.6,
    };
    const exact = service.compare({ ...input, editDistance: 0 });
    const approximate = service.compare({ ...input, editDistance: 2 });
    const unlimited = service.compare({ ...input, editDistance: 100 });

    expect(approximate.sourceToTarget.duplicateLength).toBeGreaterThanOrEqual(
      exact.sourceToTarget.duplicateLength,
    );
    expect(unlimited.editDistance).toBe(100);
    expect(approximate.editDistance).toBe(2);
    expect(exact.editDistance).toBe(0);
  });

  it('test.md case 2 highlights only the shared prefix', () => {
    const service = createService();
    const source =
      '人工智能技术正在快速改变现代教育的发展方式。教师可以利用人工智能分析学生的学习情况，并根据不同学生的知识掌握程度制定合理的教学方案。传统课堂通常采用统一的教学内容和教学进度。';
    const target =
      '人工智能技术正在快速改变现代教育的发展方式。教师可以利用人工智能分析学生的学习情况。随着在线教育平台不断发展，学生可以通过网络获得更加丰富的学习资源。';
    const result = service.compare({ source, target, threshold: 0.6 });
    const texts = result.matches.map((match) => match.text);

    expect(texts.some((text) => text.includes('人工智能技术正在快速改变现代教育的发展方式'))).toBe(
      true,
    );
    expect(texts.some((text) => text.includes('教师可以利用人工智能分析学生的学习情况'))).toBe(
      true,
    );
    expect(texts.some((text) => text.includes('并根据不同学生的知识掌握程度'))).toBe(false);
    expect(result.duplicateRate).toBeLessThan(1);
  });

  it('test.md case 3 finds a middle-only continuous match', () => {
    const service = createService();
    const source =
      '随着信息技术不断发展，人工智能已经逐渐进入教育领域。教师可以利用人工智能分析学生的学习情况，从而了解学生的知识掌握程度。通过分析学生的答题记录和错误类型，教师能够制定更加合理的教学方案。';
    const target =
      '近年来在线教育发展迅速。教师可以利用人工智能分析学生的学习情况，从而了解学生的知识掌握程度。智能教育平台还可以根据学生的学习表现推荐相关课程。';
    const result = service.compare({ source, target, threshold: 0.6 });
    const longest = result.matches.reduce((max, match) => Math.max(max, match.length), 0);

    expect(longest).toBeGreaterThanOrEqual(8);
    expect(result.duplicateRate).toBeGreaterThan(0);
    expect(result.duplicateRate).toBeLessThan(1);
  });

  it('test.md case 4 does not treat semantic similarity as text duplication', () => {
    const service = createService();
    const source =
      '人工智能正在改变传统教育模式，教师可以利用智能系统了解学生的学习情况，并针对不同学生制定个性化的教学计划。';
    const target =
      '随着智能技术的发展，学校开始采用新的教学方式。系统能够分析学生的学习数据，并帮助教师为不同学习水平的学生安排合适的课程。';
    const result = service.compare({ source, target, threshold: 0.6 });

    expect(result.duplicateRate).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it('test.md case 5 ignores short shared words', () => {
    const service = createService();
    const source = '人工智能可以帮助教师分析学生的学习情况，并提高教学效率。';
    const target = '教师需要关注学生的学习情况，并通过合理的方法提高教学效率。';
    const result = service.compare({ source, target, threshold: 0.6 });

    expect(result.matches).toHaveLength(0);
    expect(result.duplicateRate).toBe(0);
  });

  it('test.md case 6 stops a match when the following text changes', () => {
    const service = createService();
    const source = '人工智能技术正在快速改变现代教育的发展方式，并推动在线教育平台不断发展。';
    const target = '人工智能技术正在快速改变现代教育的发展方式，同时推动智能教学系统不断完善。';
    const result = service.compare({ source, target, threshold: 0.6 });

    expect(
      result.matches.some((match) =>
        match.text.includes('人工智能技术正在快速改变现代教育的发展方式'),
      ),
    ).toBe(true);
    expect(result.matches.some((match) => match.text.includes('在线教育平台不断发展'))).toBe(false);
  });

  it('test.md case 7 preserves adjacent repeated regions without losing coverage', () => {
    const service = createService();
    const source =
      '人工智能正在改变现代教育。人工智能能够分析学生数据。人工智能还可以推荐学习资源。';
    const result = service.compare({ source, target: source, threshold: 0.6 });

    expect(result.duplicateRate).toBe(1);
    expect(result.duplicateLength).toBe(result.sourceLength);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('test.md case 8 merges overlapping evidence instead of double counting', () => {
    const service = createService();
    const source = '人工智能技术正在改变现代教育的发展模式。';
    const result = service.compare({ source, target: source, threshold: 0.6 });

    expect(result.duplicateLength).toBe(result.sourceLength);
    expect(result.duplicateRate).toBe(1);
    expect(result.matches.reduce((total, match) => total + match.length, 0)).toBeLessThanOrEqual(
      result.sourceLength,
    );
  });

  it('test.md case 9 does not mark reordered text as one duplicated sentence', () => {
    const service = createService();
    const source = '人工智能可以分析学生的学习情况，并根据分析结果推荐学习资源。';
    const target = '系统可以推荐学习资源，并利用人工智能分析学生的学习情况。';
    const result = service.compare({ source, target, threshold: 0.6 });

    expect(result.duplicateRate).toBeLessThan(1);
    expect(Math.max(0, ...result.matches.map((match) => match.length))).toBeLessThan(
      result.sourceLength,
    );
  });

  it('test.md case 10 survives a small insertion', () => {
    const service = createService();
    const source = '人工智能技术正在快速改变现代教育的发展方式。';
    const target = '当前人工智能技术正在快速改变现代教育的发展方式。';
    const result = service.compare({ source, target, threshold: 0.6 });

    expect(
      result.matches.some((match) =>
        match.text.includes('人工智能技术正在快速改变现代教育的发展方式'),
      ),
    ).toBe(true);
    expect(result.duplicateRate).toBeGreaterThan(0.8);
  });

  it('test.md case 11 survives a small deletion without treating the whole text as exact', () => {
    const service = createService();
    const source = '人工智能技术正在快速改变现代教育的发展方式。';
    const target = '人工智能技术正在改变现代教育的发展方式。';
    const result = service.compare({ source, target, threshold: 0.6 });

    expect(result.duplicateRate).toBeGreaterThan(0.7);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('test.md case 12 returns no duplicate for unrelated text', () => {
    const service = createService();
    const source =
      '人工智能技术正在快速改变现代教育的发展方式。智能系统可以帮助教师分析学生的学习数据。';
    const target =
      '城市交通系统需要合理规划道路资源，并通过公共交通建设缓解高峰时期的道路拥堵问题。';
    const result = service.compare({ source, target, threshold: 0.6 });

    expect(result.duplicateRate).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it('rejects empty, normalized-empty, invalid threshold, and oversized input', () => {
    const service = createService();

    expect(() => service.compare({ source: ' ', target: '内容' })).toThrow('不能为空');
    expect(() => service.compare({ source: '<b></b>', target: '内容' })).toThrow('没有可用于查重');
    expect(() => service.compare({ source: '内容', target: '内容', threshold: 1.1 })).toThrow(
      '相似阈值必须是 0 到 1 之间',
    );
    expect(() =>
      service.compare({
        source: 'a'.repeat(PLAGIARISM_CONFIG.maxTextLength + 1),
        target: '内容',
      }),
    ).toThrow('最多');
  });
});
