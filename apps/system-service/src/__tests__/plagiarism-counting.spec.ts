import { describe, expect, it } from 'vitest';
import {
  alignMatchToCompleteUnits,
  countNormalizedUnits,
  countUnitsInRange,
  resolveCountingMode,
} from '../modules/plagiarism/plagiarism-counting';
import { normalizeText } from '../modules/plagiarism/text-normalizer';

describe('plagiarism counting units', () => {
  it('counts Latin runs as words and Han characters as characters', () => {
    const normalized = normalizeText("人工智能 improves don't-learning");

    expect(normalized.value).toBe('人工智能improvesdontlearning');
    expect(normalized.units.map((unit) => unit.kind)).toEqual([
      'character',
      'character',
      'character',
      'character',
      'word',
      'word',
      'word',
    ]);
    expect(resolveCountingMode(normalized)).toBe('mixed');
    expect(countNormalizedUnits(normalized)).toBe(7);
  });

  it('counts complete units in a normalized range', () => {
    const normalized = normalizeText('alpha bravo charlie');
    const start = normalized.units[1].start;
    const end = normalized.units[2].end;

    expect(countUnitsInRange(normalized, start, end)).toBe(2);
  });

  it('rejects a candidate with incompatible word boundaries', () => {
    const source = normalizeText('foo bar');
    const target = normalizeText('foobar');
    const aligned = alignMatchToCompleteUnits(
      {
        sourceStart: 0,
        sourceEnd: source.value.length,
        targetStart: 0,
        targetEnd: target.value.length,
        length: source.value.length,
      },
      source,
      target,
    );

    expect(aligned).toBeNull();
  });

  it('keeps the complete common word when a following word is only partially matched', () => {
    const source = normalizeText('information retrieval');
    const target = normalizeText('information retrievers');
    const aligned = alignMatchToCompleteUnits(
      {
        sourceStart: 0,
        sourceEnd: 'informationretriev'.length,
        targetStart: 0,
        targetEnd: 'informationretriev'.length,
        length: 'informationretriev'.length,
      },
      source,
      target,
    );

    expect(aligned).toMatchObject({
      sourceStart: 0,
      sourceEnd: 'information'.length,
      targetStart: 0,
      targetEnd: 'information'.length,
      length: 'information'.length,
    });
  });
});
