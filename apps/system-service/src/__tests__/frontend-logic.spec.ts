import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('static compare editor contract', () => {
  it('loads only the API-based comparison controller and explains the upload boundary', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    const app = readFileSync(resolve(process.cwd(), 'public/js/app.js'), 'utf8');
    const compare = readFileSync(resolve(process.cwd(), 'public/js/content-compare.js'), 'utf8');

    expect(html).toContain('/public/js/content-compare.js');
    expect(app).toContain('window.NestCloudContentCompare.mount(compareView)');
    expect(compare).toContain('/api/content-compare/json');
    expect(compare).toContain('/api/content-compare/env');
    for (const legacy of ['env-parser.js', 'json-diff.js']) {
      expect(html).not.toContain(legacy);
      expect(existsSync(resolve(process.cwd(), 'public/js', legacy))).toBe(false);
    }
    for (const route of ['json-compare', 'env-compare']) {
      const fragment = readFileSync(resolve(process.cwd(), `public/html/${route}.html`), 'utf8');
      expect(fragment).toContain('原文发送到本服务');
      expect(fragment).toContain('maxlength="500000"');
    }
    expect(`${app}${compare}`).not.toContain('NestCloudJsonDiff');
    expect(`${app}${compare}`).not.toContain('NestCloudEnvParser');
  });

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
      'workflow',
      'weekly-report',
      'bullmq',
      'config-file-preview',
      'token-config',
      'plagiarism',
    ];

    const app = readFileSync(resolve(process.cwd(), 'public/js/app.js'), 'utf8');
    expect(html).toContain('id="main-content"');
    expect(html).toContain('id="view-host"');
    expect(html).not.toContain('data-view="overview"');
    expect([...html.matchAll(/data-route="([^"]+)"/g)].map((match) => match[1])).toEqual(routes);
    routes.forEach((route) => {
      const fragment = readFileSync(resolve(process.cwd(), `public/html/${route}.html`), 'utf8');
      expect(fragment).toContain(`data-view="${route}"`);
      expect((fragment.match(/<section\b/g) ?? []).length).toBeGreaterThan(0);
      expect(app).toContain(`/public/html/${route}.html`);
    });
    for (const [, script] of html.matchAll(/<script src="\/public\/([^"]+)"/g)) {
      expect(existsSync(resolve(process.cwd(), 'public', script))).toBe(true);
    }
  });
});

describe('weekly report menu contract', () => {
  it('connects the menu, route registry, and view fragment', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    const weekly = readFileSync(resolve(process.cwd(), 'public/html/weekly-report.html'), 'utf8');
    const app = readFileSync(resolve(process.cwd(), 'public/js/app.js'), 'utf8');
    const compare = readFileSync(resolve(process.cwd(), 'public/js/content-compare.js'), 'utf8');

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
    expect(weekly).toContain('需在 Token 配置页完整填写 AI 三项');
    expect(weekly).toContain('不使用本地摘要');
    expect(weekly).not.toContain('只由服务端环境提供');
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
    expect(compare).toContain('nestcloud:compare:json:v1');
    expect(compare).toContain('nestcloud:compare:env:v1');
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
    const css = readFileSync(resolve(process.cwd(), 'public/css/app.css'), 'utf8');

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
    expect(css).toContain('.config-file-preview-view {');
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

describe('retired release feature', () => {
  it('does not expose release routes, scripts, fragments or backend modules', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    const app = readFileSync(resolve(process.cwd(), 'public/js/app.js'), 'utf8');
    const css = readFileSync(resolve(process.cwd(), 'public/css/app.css'), 'utf8');

    expect(html).not.toContain('release-automation');
    expect(app).not.toContain('release-automation');
    expect(app).not.toContain('NestCloudReleaseAutomation');
    expect(css).not.toContain('.release-');
    for (const path of [
      'public/html/release-automation.html',
      'public/js/release-automation.js',
      'src/modules/release-automation',
    ]) {
      expect(existsSync(resolve(process.cwd(), path))).toBe(false);
    }
  });
});

describe('token config menu contract', () => {
  it('provides localStorage configuration for shared credentials and AI summaries', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    const fragment = readFileSync(resolve(process.cwd(), 'public/html/token-config.html'), 'utf8');
    const script = readFileSync(resolve(process.cwd(), 'public/js/token-config.js'), 'utf8');
    const app = readFileSync(resolve(process.cwd(), 'public/js/app.js'), 'utf8');

    expect(html).toContain('href="#token-config" data-route="token-config"');
    expect(fragment).toContain('data-view="token-config"');
    expect(fragment).toContain('id="token-github"');
    expect(fragment).not.toContain('token-jenkins');
    expect(fragment).toContain('class="token-credential-warning"');
    expect(script).not.toContain('jenkins');
    expect(fragment).toContain('id="token-feishu-app-id"');
    expect(fragment).toContain('id="token-feishu-app-secret"');
    expect(fragment).toContain('id="token-ai-base-url"');
    expect(fragment).toContain('id="token-ai-api-key"');
    expect(fragment).toContain('id="token-ai-model"');
    expect(fragment).toContain('maxlength="2048"');
    expect(fragment).toContain('maxlength="4096"');
    expect(fragment).toContain('maxlength="256"');
    expect(fragment).toContain('不完整');
    expect(fragment).toContain('仍可保存草稿，但无法生成周报');
    expect(fragment).toContain('AI 请求失败不会改用本地摘要');
    expect(fragment).not.toContain('全部留空时使用本地规则摘要');
    expect(script).toContain('nestcloud:release-tokens:v1');
    expect(script).toContain('value.ai');
    expect(script).toContain('const ai = {');
    expect(script).toContain("aiBaseUrl.value = ''");
    expect(script).toContain('localStorage');
    expect(app).toContain("'token-config': { title: 'Token 配置'");
    expect(app).toContain('tokenConfig.ai');
    expect(app).toContain('AI 配置不完整');
    expect(script).not.toContain('aiBaseUrl:');
    expect(script).not.toContain('aiApiKey:');
    expect(script).not.toContain('aiModel:');
  });
});

describe('plagiarism menu contract', () => {
  it('connects the route, fragment, script, threshold, API and explainable result steps', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    const fragment = readFileSync(resolve(process.cwd(), 'public/html/plagiarism.html'), 'utf8');
    const app = readFileSync(resolve(process.cwd(), 'public/js/app.js'), 'utf8');
    const script = readFileSync(resolve(process.cwd(), 'public/js/plagiarism.js'), 'utf8');
    const css = readFileSync(resolve(process.cwd(), 'public/css/app.css'), 'utf8');

    expect(html).toContain('href="#plagiarism" data-route="plagiarism"');
    expect(html).toContain('<script src="/public/js/plagiarism.js" defer></script>');
    expect(fragment).toContain('data-view="plagiarism"');
    expect(fragment).toContain('id="plagiarism-source"');
    expect(fragment).toContain('id="plagiarism-target"');
    expect(fragment).toContain('id="plagiarism-threshold"');
    expect(fragment).toContain('min="0" max="1" step="0.05"');
    expect(fragment).toContain('id="plagiarism-step-list"');
    expect(fragment).toContain('id="plagiarism-edit-distance"');
    expect(fragment).toContain('min="0" step="1" value="2"');
    expect(fragment).toContain('class="plagiarism-editor__highlight"');
    expect(fragment).toContain('id="plagiarism-source-original"');
    expect(fragment).toContain('id="plagiarism-target-original"');
    expect(app).toContain("plagiarism: { title: '论文查重'");
    expect(app).toContain("plagiarism: '/public/html/plagiarism.html'");
    expect(app).toContain('window.NestCloudPlagiarism.mount');
    expect(script).toContain("'/api/plagiarism/compare'");
    expect(script).toContain('editDistance');
    expect(script).toContain('JSON.stringify({');
    expect(script).toContain('dataset.tooltip');
    expect(script).toContain('renderStepList');
    expect(script).toContain('renderOriginalText');
    expect(script).toContain('scrollMatchIntoView');
    expect(script).toContain('plagiarism-highlight--');
    expect(css).toContain('.plagiarism-highlight--1');
    expect(css).toContain('.plagiarism-highlight--4');
    expect(script).toContain('sourceToTarget');
    expect(script).toContain('targetToSource');
    expect(script).toContain('A 重复率');
    expect(script).toContain('B 重复率');
    expect(script).toContain('duplicateUnitCount');
    expect(script).toContain('sourceUnitCount');
    expect(script).toContain('countingMode');
    expect(fragment).toContain('中文按字、英文按完整单词计算重复率');
    expect(script).toContain('requestController');
    expect(script).toContain('localStorage');
    expect(script).toContain('nestcloud:plagiarism:v1');
    expect(script).not.toContain('innerHTML');
    expect(css).toContain('.plagiarism-highlight:hover::after');
    expect(css).toContain('.plagiarism-step-list');
  });
});
