import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlagiarismService } from '../modules/plagiarism/plagiarism.service';

const fixture = readFileSync(resolve(__dirname, 'fixtures/论文查重中.md'), 'utf8');

function extractTextSection(title: string, nextTitle: string): string {
  const startMarker = `\n# ${title}`;
  const endMarker = `\n# ${nextTitle}`;
  const start = fixture.indexOf(startMarker);
  const end = fixture.indexOf(endMarker, start + startMarker.length);
  return fixture
    .slice(start + startMarker.length, end)
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('#') && trimmed !== '---';
    })
    .join('\n');
}

const source = extractTextSection('Text A', 'Text B');
const target = extractTextSection('Text B', '预期查重结果');

describe('论文查重中.md long-form fixture', () => {
  it('keeps exact evidence while rejecting semantic rewrites', () => {
    const result = new PlagiarismService().compare({ source, target, threshold: 0.6 });
    const forward = result.sourceToTarget;
    const reverse = result.targetToSource;
    const texts = forward.matches.map((match) => match.text);

    expect(source.length).toBeGreaterThan(1000);
    expect(target.length).toBeGreaterThan(1000);
    expect(forward.duplicateRate).toBeGreaterThan(0);
    expect(reverse.duplicateRate).toBeGreaterThan(0);
    expect(texts.some((text) => text.includes('传统课堂通常采用统一的教学内容和教学进度'))).toBe(
      true,
    );
    expect(
      texts.some((text) => text.includes('个性化学习是人工智能在教育领域的重要应用方向之一')),
    ).toBe(false);
    expect(texts.some((text) => text.includes('教师仍然需要根据课程目标设计教学内容'))).toBe(false);
    expect(texts.every((text) => [...text].length >= 8)).toBe(true);
    expect(forward.duplicateLength).toBeLessThanOrEqual(forward.sourceLength);
    expect(reverse.duplicateLength).toBeLessThanOrEqual(reverse.sourceLength);
  });

  it('does not turn common short vocabulary into the dominant evidence', () => {
    const result = new PlagiarismService().compare({ source, target, threshold: 0.6 });
    const texts = result.sourceToTarget.matches.map((match) => match.text);
    const commonWords = ['人工智能', '教师', '学生', '学习', '教育', '学校', '数据', '教学'];

    expect(texts.some((text) => commonWords.includes(text))).toBe(false);
  });
});
