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
  compareJson(
    left: unknown,
    right: unknown,
  ): {
    left: unknown;
    right: unknown;
    stats: { added: number; removed: number; modified: number };
    tree: { path: string; status: string; children: unknown[] };
  };
  serializeDiffSegments(
    tree: unknown,
    side: 'left' | 'right',
  ): Array<{ text: string; status: string | null }>;
}

const envParser = require('../../public/js/env-parser.js') as EnvParser;
const jsonDiff = require('../../public/js/json-diff.js') as JsonDiff;

describe('static frontend parsers', () => {
  it('preserves ENV string values and quoted syntax', () => {
    const result = envParser.parseEnv(
      '﻿# comment\r\nexport APP_NAME="particle"\r\nPORT=3000\r\nURL=a=b#fragment\r\nHASH=foo # trailing comment\r\nEMPTY=',
    );

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
    const result = envParser.parseEnv(
      'BAD-KEY=x\nNO_EQUALS\nOPEN="value\nOK="done"junk\nNAME=one\nNAME=two',
    );

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
      {
        items: [
          { id: 2, name: 'b' },
          { id: 1, name: 'a' },
        ],
      },
      {
        items: [
          { id: 1, name: 'A' },
          { id: 3, name: 'c' },
        ],
      },
    );

    expect(result.stats).toEqual({ added: 1, removed: 1, modified: 1 });
    expect(result.left).toEqual({
      items: [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ],
    });
    expect(result.right).toEqual({
      items: [
        { id: 1, name: 'A' },
        { id: 3, name: 'c' },
      ],
    });
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
  it('keeps compare controls and editors in each page fragment', () => {
    const json = readFileSync(resolve(process.cwd(), 'public/html/json-compare.html'), 'utf8');
    const env = readFileSync(resolve(process.cwd(), 'public/html/env-compare.html'), 'utf8');

    expect((`${json}${env}`.match(/class="compare-editor__highlight"/g) ?? []).length).toBe(4);
    expect((`${json}${env}`.match(/class="compare-editor__textarea"/g) ?? []).length).toBe(4);
    expect((`${json}${env}`.match(/data-compare-swap=/g) ?? []).length).toBe(2);
    expect(json.indexOf('data-compare-action="json"')).toBeLessThan(json.indexOf('id="json-a"'));
    expect(env.indexOf('data-compare-action="env"')).toBeLessThan(env.indexOf('id="env-a"'));
  });
});

describe('static shell and fragment contract', () => {
  it('keeps the entry document as a shell and exposes all page fragments', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    const routes = [
      'overview',
      'particle',
      'json-compare',
      'env-compare',
      'weekly-report',
      'bullmq',
      'config-file-preview',
      'release-automation',
      'token-config',
    ];

    expect(html).toContain('id="main-content"');
    expect(html).toContain('id="view-host"');
    expect(html).not.toContain('data-view="overview"');
    routes.forEach((route) => {
      const fragment = readFileSync(resolve(process.cwd(), `public/html/${route}.html`), 'utf8');
      expect(fragment).toContain(`data-view="${route}"`);
      expect((fragment.match(/<section\b/g) ?? []).length).toBeGreaterThan(0);
    });
  });
});

describe('weekly report menu contract', () => {
  it('connects the menu, route registry, and view fragment', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    const weekly = readFileSync(resolve(process.cwd(), 'public/html/weekly-report.html'), 'utf8');
    const app = readFileSync(resolve(process.cwd(), 'public/js/app.js'), 'utf8');

    expect(html).toContain('href="#weekly-report" data-route="weekly-report"');
    expect(weekly).toContain('data-view="weekly-report"');
    expect(weekly).toContain('id="weekly-report-progress"');
    expect(weekly).toContain('id="weekly-report-project-errors"');
    expect(weekly).toContain('id="weekly-report-publish"');
    expect(weekly).toContain('type="checkbox" name="weekly-report-publish" />');
    expect(weekly).toContain('id="weekly-feishu-settings"');
    expect(weekly).toContain('id="weekly-feishu-app-secret"');
    expect(weekly).toContain('id="weekly-feishu-wiki-url"');
    expect(weekly).toContain('id="weekly-feishu-name"');
    expect(weekly).toContain('?sheet=');
    expect(weekly).not.toContain('type="month"');
    expect(weekly).not.toContain('data-weekly-feishu-field="month"');
    expect(weekly).not.toContain('data-weekly-feishu-field="lookupRange"');
    expect(weekly).not.toContain('id="weekly-feishu-target-add"');
    expect(weekly).not.toContain('id="weekly-feishu-target-template"');
    expect(weekly).not.toContain('data-weekly-feishu-target-remove');
    expect(weekly).not.toContain('月度表格目标');
    expect(weekly).toContain('仅上周周报支持同步');
    expect(weekly).toContain('id="weekly-project-add"');
    expect(weekly).toContain('id="weekly-project-template"');
    expect(weekly).not.toContain('wzj-nodejs-v2');
    expect(weekly).not.toContain('2451477516@qq.com');
    expect(weekly).not.toContain('default-0');
    expect(weekly).toContain('data-weekly-project-remove');
    expect(weekly).toContain('form="weekly-report-form"');
    expect(weekly).toContain('aria-valuenow="0"');
    expect(weekly).toContain('role="alert"');
    expect(weekly.indexOf('id="weekly-report-submit"')).toBeLessThan(
      weekly.indexOf('PROJECT SOURCES'),
    );
    expect(app).toContain("'weekly-report': { title: '周报生成'");
    expect(app).toContain('weekly-report.html');
    expect(app).toContain('/api/weekly-commit-reports/jobs');
    expect(app).toContain('/api/weekly-commit-reports/jobs/status?jobId=');
    expect(app).toContain('const publish = { enabled: publishEnabled }');
    expect(app).toContain('if (publishEnabled) publish.settings = collectPublishSettings()');
    expect(app).toContain('runtime');
    expect(app).toContain('githubToken');
    expect(app).toContain('publishSettings');
    expect(app).not.toContain('requestTimeoutMs: Number.parseInt');
    expect(app).not.toContain('maxRetries: Number.parseInt');
    expect(app).not.toContain('data-weekly-feishu-field="sheetId"');
    expect(app).not.toContain('weekly-feishu-target-list');
    expect(app).not.toContain('weekly-feishu-target-add');
    expect(app).not.toContain('MAX_FEISHU_TARGETS');
    expect(app).not.toContain('extractSheetId');
    expect(app).toContain('normalizeFeishuSettings');
    expect(app).toContain('nestcloud:weekly-report:v1');
    expect(app).toContain('nestcloud:compare:json:v1');
    expect(app).toContain('nestcloud:compare:env:v1');
    expect(app).toContain('localStorage');
    expect(app).toContain('projectErrors');
    expect(app).toContain('renderProjectErrors');
  });
});

describe('bullmq panel menu contract', () => {
  it('connects the BullMQ menu, fragment, and embedded panel route', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    const fragment = readFileSync(resolve(process.cwd(), 'public/html/bullmq.html'), 'utf8');
    const app = readFileSync(resolve(process.cwd(), 'public/js/app.js'), 'utf8');
    const css = readFileSync(resolve(process.cwd(), 'public/css/app.css'), 'utf8');

    expect(html).toContain('href="#bullmq" data-route="bullmq"');
    expect(fragment).toContain('data-view="bullmq"');
    expect(fragment).toContain('src="/ops/queues/"');
    expect(fragment).toContain('title="BullMQ 队列监控面板"');
    expect(fragment).toContain('loading="eager"');
    expect(fragment).toContain('class="bullmq-frame-wrap"');
    expect(app).toContain("bullmq: { title: 'BullMQ 面板'");
    expect(app).toContain("bullmq: '/public/html/bullmq.html'");
    expect(css).toContain(".main-content[data-route='bullmq']");
    expect(css).toContain('height: calc(100dvh - var(--topbar-height))');
    expect(css).toContain('height: 100%;');
  });
});

describe('config file preview menu contract', () => {
  it('connects the editable form, route, script, and safe text output', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    const fragment = readFileSync(
      resolve(process.cwd(), 'public/html/config-file-preview.html'),
      'utf8',
    );
    const app = readFileSync(resolve(process.cwd(), 'public/js/app.js'), 'utf8');
    const preview = readFileSync(
      resolve(process.cwd(), 'public/js/config-file-preview.js'),
      'utf8',
    );

    expect(html).toContain('href="#config-file-preview" data-route="config-file-preview"');
    expect(fragment).toContain('data-view="config-file-preview"');
    expect(fragment).toContain('id="config-preview-repository-url"');
    expect(fragment).toContain('id="config-preview-branch"');
    expect(fragment).toContain('id="config-preview-file-path"');
    expect(fragment).toContain('id="config-preview-tag"');
    expect(fragment).toContain('list="config-preview-tags"');
    expect(fragment).toContain('id="config-preview-tags"');
    expect(fragment).not.toContain(
      'id="config-preview-tag" name="tag" type="text" autocomplete="off" list="config-preview-tags" required',
    );
    expect(fragment).toContain('role="alert"');
    expect(fragment).toContain('aria-live="polite"');
    expect(html).toContain('<script src="/public/js/config-file-preview.js" defer></script>');
    expect(app).toContain("'config-file-preview': { title: '配置版本预览'");
    expect(app).toContain('config-file-preview.html');
    expect(preview).not.toContain("'/api/config-file-preview/defaults'");
    expect(preview).toContain("'/api/config-file-preview/tags'");
    expect(preview).toContain("'/api/config-file-preview/preview'");
    expect(preview).toContain('githubToken');
    expect(preview).toContain('nestcloud:config-file-preview:v1');
    expect(preview).toContain('saveCurrentDraft');
    expect(preview).toContain('selectedTag');
    expect(preview).toContain('submittedTag');
    expect(preview).toContain('restoreDraft');
    expect(preview).toContain('scheduleTagLookup');
    expect(preview).toContain('window.NestCloudConfigFilePreview');
    expect(preview).toContain('output.textContent = latestContent');
    expect(preview).not.toContain('innerHTML');
  });
});

describe('release automation menu contract', () => {
  it('connects the 1.9.0 page and keeps the dry-run/idempotency contract', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    const fragment = readFileSync(
      resolve(process.cwd(), 'public/html/release-automation.html'),
      'utf8',
    );
    const app = readFileSync(resolve(process.cwd(), 'public/js/app.js'), 'utf8');
    const script = readFileSync(resolve(process.cwd(), 'public/js/release-automation.js'), 'utf8');

    expect(html).toContain('href="#release-automation" data-route="release-automation"');
    expect(fragment).toContain('data-view="release-automation"');
    expect(fragment).toContain('发布版本');
    expect(fragment).toContain('id="release-git-address"');
    expect(fragment).toContain('id="release-git-tag"');
    expect(fragment).not.toContain('id="release-project-name"');
    expect(fragment).not.toContain('id="release-candidate-sha"');
    expect(fragment).toContain('href="#token-config"');
    expect(script).toContain('githubToken');
    expect(script).toContain('jenkinsToken');
    expect(script).toContain('feishuAppId');
    expect(script).toContain('feishuAppSecret');
    expect(script).toContain('localStorage');
    expect(fragment).toContain('id="release-automation-log"');
    expect(fragment).toContain('执行任务列表');
    expect(fragment).toContain('执行发布');
    expect(script).toContain('EXECUTION_TASKS');
    expect(script).toContain("checkbox.type = 'checkbox'");
    expect(script).toContain('selectedTasks');
    expect(app).toContain("'release-automation': { title: '发布版本'");
    expect(app).toContain("'release-automation': '/public/html/release-automation.html'");
    expect(html).toContain('<script src="/public/js/release-automation.js" defer></script>');
    expect(script).toContain("'Idempotency-Key'");
    expect(script).not.toContain("mode: 'dry-run'");
    expect(script).not.toContain('innerHTML');
  });
});

describe('token config menu contract', () => {
  it('provides localStorage configuration for release credentials and AI summaries', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    const fragment = readFileSync(resolve(process.cwd(), 'public/html/token-config.html'), 'utf8');
    const script = readFileSync(resolve(process.cwd(), 'public/js/token-config.js'), 'utf8');
    const app = readFileSync(resolve(process.cwd(), 'public/js/app.js'), 'utf8');

    expect(html).toContain('href="#token-config" data-route="token-config"');
    expect(fragment).toContain('data-view="token-config"');
    expect(fragment).toContain('id="token-github"');
    expect(fragment).toContain('id="token-jenkins"');
    expect(fragment).toContain('id="token-feishu-app-id"');
    expect(fragment).toContain('id="token-feishu-app-secret"');
    expect(fragment).toContain('id="token-ai-base-url"');
    expect(fragment).toContain('id="token-ai-api-key"');
    expect(fragment).toContain('id="token-ai-model"');
    expect(fragment).toContain('maxlength="2048"');
    expect(fragment).toContain('maxlength="4096"');
    expect(fragment).toContain('maxlength="256"');
    expect(fragment).toContain('不完整');
    expect(script).toContain('nestcloud:release-tokens:v1');
    expect(script).toContain('value.ai');
    expect(script).toContain('const ai = {');
    expect(script).toContain("aiBaseUrl.value = ''");
    expect(script).toContain('localStorage');
    expect(app).toContain("'token-config': { title: 'Token 配置'");
    expect(app).toContain('releaseTokens.ai');
    expect(app).toContain('AI 配置不完整');
    expect(script).not.toContain('aiBaseUrl:');
    expect(script).not.toContain('aiApiKey:');
    expect(script).not.toContain('aiModel:');
  });
});
