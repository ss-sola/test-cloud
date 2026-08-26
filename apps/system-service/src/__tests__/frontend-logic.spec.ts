import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ParseError {
  code: string;
  line: number;
  previousLine?: number;
}

interface EnvParser {
  parseEnv(text: string): {
    ok: boolean;
    value: Record<string, string> | null;
    errors: ParseError[];
  };
}

interface JsonDiff {
  compareJson(left: unknown, right: unknown): {
    left: unknown;
    right: unknown;
    stats: { added: number; removed: number; modified: number };
    tree: { path: string; status: string; children: unknown[] };
  };
  serializeDiffSegments(tree: unknown, side: 'left' | 'right'): Array<{ text: string; status: string | null }>;
}

const envParser = require('../../public/js/env-parser.js') as EnvParser;
const jsonDiff = require('../../public/js/json-diff.js') as JsonDiff;

describe('static frontend parsers', () => {
  it('preserves ENV string values and quoted syntax', () => {
    const result = envParser.parseEnv('﻿# comment\r\nexport APP_NAME="particle"\r\nPORT=3000\r\nURL=a=b#fragment\r\nHASH=foo # trailing comment\r\nEMPTY=');

    expect(result.ok).toBe(true);
    expect(Object.fromEntries(Object.entries(result.value ?? {}))).toEqual({
      APP_NAME: 'particle',
      PORT: '3000',
      URL: 'a=b#fragment',
      HASH: 'foo',
      EMPTY: '',
    });
  });

  it('reports malformed ENV lines without accepting partial values', () => {
    const result = envParser.parseEnv('BAD-KEY=x\nNO_EQUALS\nOPEN="value\nOK="done"junk\nNAME=one\nNAME=two');

    expect(result.ok).toBe(false);
    expect(result.value).toBeNull();
    expect(result.errors.map(({ code, line }) => [code, line])).toEqual([
      ['INVALID_KEY', 1],
      ['MISSING_EQUALS', 2],
      ['UNTERMINATED_QUOTE', 3],
      ['TRAILING_CONTENT', 4],
      ['DUPLICATE_KEY', 6],
    ]);
    expect(result.errors.at(-1)?.previousLine).toBe(5);
  });

  it('keeps special ENV keys as own properties', () => {
    const result = envParser.parseEnv('__proto__=safe\nconstructor=value');

    expect(result.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result.value, '__proto__')).toBe(true);
    expect(result.value?.__proto__).toBe('safe');
    expect(result.value?.constructor).toBe('value');
  });
});

describe('static JSON diff', () => {
  it('matches identity arrays independent of input order', () => {
    const result = jsonDiff.compareJson(
      { items: [{ id: 2, name: 'b' }, { id: 1, name: 'a' }] },
      { items: [{ id: 1, name: 'A' }, { id: 3, name: 'c' }] },
    );

    expect(result.stats).toEqual({ added: 1, removed: 1, modified: 1 });
    expect(result.left).toEqual({ items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
    expect(result.right).toEqual({ items: [{ id: 1, name: 'A' }, { id: 3, name: 'c' }] });
    expect(result.tree.path).toBe('$');
  });

  it('treats reordered non-identity arrays as unchanged after normalization', () => {
    const result = jsonDiff.compareJson({ values: [3, 1, 2] }, { values: [2, 3, 1] });

    expect(result.stats).toEqual({ added: 0, removed: 0, modified: 0 });
  });

  it('serializes changed leaves into side-specific segments', () => {
    const result = jsonDiff.compareJson({ name: 'before' }, { name: 'after', ready: true });
    const left = jsonDiff.serializeDiffSegments(result.tree, 'left');
    const right = jsonDiff.serializeDiffSegments(result.tree, 'right');

    expect(left.some((segment) => segment.status === 'modified')).toBe(true);
    expect(right.some((segment) => segment.status === 'added')).toBe(true);
  });
});

describe('static compare editor contract', () => {
  it('keeps the highlight layer positioned and aligned with each textarea', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');

    expect((html.match(/class="compare-editor__highlight"/g) ?? []).length).toBe(4);
    expect((html.match(/class="compare-editor__textarea"/g) ?? []).length).toBe(4);
  });
});

describe('weekly report menu contract', () => {
  it('connects the menu, route registry, and view', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    const app = readFileSync(resolve(process.cwd(), 'public/js/app.js'), 'utf8');

    expect(html).toContain('href="#weekly-report" data-route="weekly-report"');
    expect(html).toContain('data-view="weekly-report"');
    expect(html).toContain('id="weekly-report-progress"');
    expect(html.indexOf('id="weekly-report-submit"')).toBeLessThan(html.indexOf('PROJECT SOURCES'));
    expect(app).toContain("'weekly-report': { title: '周报生成'");
    expect(app).toContain("fetch('/api/weekly-commit-reports/generate'");
  });
});
