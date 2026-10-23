import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { WeeklyReportResult } from '../modules/weekly-commit-report/weekly-report.types';

type Listener = (event: { preventDefault(): void }) => void | Promise<void>;

/** 仅模拟周报表单实际使用的 DOM 能力；不实现浏览器排版或网络。 */
class FakeElement {
  textContent = '';
  hidden = false;
  disabled = false;
  value = '';
  checked = false;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly selectors = new Map<string, FakeElement>();
  readonly groups = new Map<string, FakeElement[]>();
  readonly attributes = new Map<string, string>();
  readonly classList = { toggle: vi.fn(), contains: vi.fn(() => false) };
  private readonly listeners = new Map<string, Listener[]>();

  querySelector(selector: string): FakeElement | null {
    if (selector === 'input[name="weekly-period"]:checked') {
      return this.groups.get('input[name="weekly-period"]')?.find((input) => input.checked) ?? null;
    }
    return this.selectors.get(selector) ?? this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === '[data-weekly-project]') return this.children;
    if (selector === '[data-weekly-project-remove]') {
      return this.children.flatMap((card) => card.querySelector(selector) ?? []);
    }
    return this.groups.get(selector) ?? [];
  }

  append(...elements: FakeElement[]): void {
    this.children.push(...elements);
  }

  replaceChildren(...elements: FakeElement[]): void {
    this.children.length = 0;
    this.textContent = '';
    this.append(...elements);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** 等待事件处理器结束，覆盖异步创建任务、轮询及 finally 解锁。 */
  async emit(type: string): Promise<void> {
    for (const listener of this.listeners.get(type) ?? []) {
      await listener({ preventDefault() {} });
    }
  }
}

class FakeInput extends FakeElement {}
class FakeButton extends FakeElement {}
class FakeFieldset extends FakeElement {}
class FakeForm extends FakeElement {
  reportValidity(): boolean {
    return true;
  }
}
class FakeProjectCard extends FakeElement {
  constructor() {
    super();
    for (const field of ['repo', 'person', 'branch']) {
      this.selectors.set(`[data-weekly-field="${field}"]`, new FakeInput());
    }
    this.selectors.set('[data-weekly-project-label]', new FakeElement());
    this.selectors.set('[data-weekly-project-index]', new FakeElement());
    this.selectors.set('[data-weekly-project-remove]', new FakeButton());
  }

  cloneNode(): FakeProjectCard {
    return new FakeProjectCard();
  }
}
class FakeTemplate extends FakeElement {
  readonly content = { firstElementChild: new FakeProjectCard() };
}

const TOKEN_KEY = 'nestcloud:release-tokens:v1';
const WEEKLY_KEY = 'nestcloud:weekly-report:v1';
const AI = { baseUrl: 'https://ai.example.com/v1', apiKey: 'test-key', model: 'test-model' };
const PROJECT = {
  repo: 'https://github.com/example/project.git',
  person: 'person',
  branch: 'main',
};
const RESULT: WeeklyReportResult = {
  period: 'last-week',
  weekStart: '2026-10-12',
  weekEnd: '2026-10-18',
  markdown: '# 周报\n1. 更新项目配置\n',
  projects: [],
  projectErrors: [],
  commitCount: 1,
  degraded: false,
};
const SCRIPT = readFileSync(resolve(__dirname, '../../public/js/app.js'), 'utf8');

/** 只替换 fragment 加载入口，直接挂载周报，业务函数保持原样且不暴露测试专用生产接口。 */
function mountWeeklyReport(tokens: unknown = { githubToken: 'github-test', ai: AI }) {
  const root = new FakeElement();
  const form = new FakeForm();
  root.selectors.set('#weekly-report-form', form);
  const periods = ['last-week', 'this-week'].map((value) => {
    const input = new FakeInput();
    input.value = value;
    input.checked = value === 'last-week';
    return input;
  });
  for (const element of [form, root]) element.groups.set('input[name="weekly-period"]', periods);
  for (const id of ['submit', 'copy', 'download'])
    root.selectors.set(`#weekly-report-${id}`, new FakeButton());
  for (const id of [
    'error',
    'project-errors',
    'status',
    'status-label',
    'meta',
    'progress',
    'progress-label',
    'output',
    'actions',
  ]) {
    root.selectors.set(`#weekly-report-${id}`, new FakeElement());
  }
  root.selectors.set('#weekly-report-publish', new FakeInput());
  root.selectors.set('#weekly-feishu-settings', new FakeFieldset());
  for (const id of ['app-id', 'app-secret', 'wiki-url', 'name']) {
    root.selectors.set(`#weekly-feishu-${id}`, new FakeInput());
  }
  const track = new FakeElement();
  track.selectors.set('span', new FakeElement());
  root.selectors.set('.weekly-report-progress__track', track);
  root.selectors.set('#weekly-project-list', new FakeElement());
  root.selectors.set('#weekly-project-template', new FakeTemplate());
  root.selectors.set('#weekly-project-count', new FakeElement());
  root.selectors.set('#weekly-project-add', new FakeButton());

  const storage = new Map<string, string>([
    [TOKEN_KEY, JSON.stringify(tokens)],
    [WEEKLY_KEY, JSON.stringify({ version: 1, projects: [PROJECT], period: 'last-week' })],
  ]);
  const fetch = vi.fn();
  const writeText = vi.fn();
  const createObjectURL = vi.fn();
  const shell = new Map<string, FakeElement>([
    ['.app-shell', new FakeElement()],
    ['#sidebar', new FakeElement()],
    ['[data-sidebar-close]', new FakeElement()],
    ['#mobile-menu-button', new FakeButton()],
    ['#breadcrumb-current', new FakeElement()],
    ['#main-content', new FakeElement()],
    ['#view-host', new FakeElement()],
    ['[data-view="weekly-report"]', root],
  ]);
  const context = createContext({
    document: {
      querySelector: (selector: string) => shell.get(selector) ?? null,
      querySelectorAll: () => [],
      createElement: () => new FakeElement(),
      addEventListener: vi.fn(),
    },
    window: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      addEventListener: vi.fn(),
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
    },
    HTMLElement: FakeElement,
    HTMLFormElement: FakeForm,
    HTMLInputElement: FakeInput,
    HTMLButtonElement: FakeButton,
    HTMLFieldSetElement: FakeFieldset,
    HTMLTemplateElement: FakeTemplate,
    fetch,
    navigator: { clipboard: { writeText } },
    URL: { createObjectURL, revokeObjectURL: vi.fn() },
    AbortController,
    Error,
  });
  const source = SCRIPT.replace('  void loadViews()', '  mountWeeklyReport()');
  if (source === SCRIPT) throw new Error('周报挂载入口已变化，请更新测试夹具。');
  runInContext(source, context);
  return { root, form, storage, fetch, writeText, createObjectURL };
}

/** 构造统一响应包装，不执行真实 HTTP。 */
function response(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ data }) };
}

/** 为一次创建和一次终态轮询排入可控响应。 */
function queueSuccess(fetch: ReturnType<typeof vi.fn>, result = RESULT) {
  fetch.mockResolvedValueOnce(response({ jobId: 'job-test' })).mockResolvedValueOnce(
    response({
      status: 'succeeded',
      result,
      publication: null,
    }),
  );
}

describe('weekly report page strict AI generation', () => {
  it.each<[string, unknown]>([
    ['missing token config', null],
    ['missing AI config', { githubToken: 'github-test' }],
    ['empty AI object', { ai: {} }],
    ['all blank fields', { ai: { baseUrl: '  ', apiKey: '\t', model: '\n' } }],
    ...Array.from({ length: 6 }, (_, index): [string, unknown] => {
      const mask = index + 1;
      return [
        `partial AI config ${mask}`,
        {
          ai: Object.fromEntries(
            Object.entries(AI).map(([field, value], bit) => [
              field,
              mask & (1 << bit) ? value : '',
            ]),
          ),
        },
      ];
    }),
    ...Object.keys(AI).map((field): [string, unknown] => [
      `whitespace ${field}`,
      { ai: { ...AI, [field]: ' \t ' } },
    ]),
    ['non-string model', { ai: { ...AI, model: 42 } }],
  ])('blocks %s before creating a job', async (_name, tokens) => {
    const { root, form, fetch } = mountWeeklyReport(tokens);

    await form.emit('submit');

    expect(fetch).not.toHaveBeenCalled();
    expect(root.querySelector('#weekly-report-error')?.textContent).toContain('AI 配置不完整');
    expect(root.querySelector('#weekly-report-error')?.hidden).toBe(false);
    expect(root.querySelector('#weekly-report-output')?.hidden).toBe(true);
    expect(root.querySelector('#weekly-report-actions')?.hidden).toBe(true);
    expect(root.querySelector('#weekly-report-submit')?.disabled).toBe(false);
  });

  it('sends complete trimmed runtime.ai with every creation request and renders the AI result', async () => {
    const { root, form, fetch } = mountWeeklyReport({
      githubToken: 'github-test',
      ai: Object.fromEntries(Object.entries(AI).map(([key, value]) => [key, ` ${value} `])),
    });
    queueSuccess(fetch);
    expect(fetch).not.toHaveBeenCalled();

    await form.emit('submit');

    expect(fetch).toHaveBeenCalledTimes(2);
    const [path, request] = fetch.mock.calls[0];
    expect(path).toBe('/api/weekly-commit-reports/jobs');
    expect(request).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(JSON.parse(request.body)).toEqual({
      period: 'last-week',
      configs: [PROJECT],
      runtime: {
        githubToken: 'github-test',
        allowedRepositories: [PROJECT.repo],
        ai: { ...AI, enableThinking: false },
      },
      publish: { enabled: false },
    });
    expect(fetch.mock.calls[1][0]).toBe('/api/weekly-commit-reports/jobs/status?jobId=job-test');
    expect(root.querySelector('#weekly-report-meta')?.textContent).toContain('AI 摘要');
    expect(root.querySelector('#weekly-report-output')?.textContent).toBe(RESULT.markdown);
    expect(root.querySelector('#weekly-report-output')?.hidden).toBe(false);
  });

  it.each<[string, unknown, boolean]>([
    ['stored true', true, true],
    ['stored false', false, false],
    ['missing field', undefined, false],
    ['string "true"', 'true', false],
    ['number 1', 1, false],
  ])(
    'passes runtime.ai.enableThinking as a strict boolean (%s)',
    async (_name, stored, expected) => {
      const { form, fetch } = mountWeeklyReport({
        githubToken: 'github-test',
        ai: { ...AI, ...(stored === undefined ? {} : { enableThinking: stored }) },
      });
      queueSuccess(fetch);

      await form.emit('submit');

      expect(JSON.parse(fetch.mock.calls[0][1].body).runtime.ai).toEqual({
        ...AI,
        enableThinking: expected,
      });
    },
  );

  it('does not let enableThinking alone satisfy the AI completeness check', async () => {
    const { root, form, fetch } = mountWeeklyReport({
      githubToken: 'github-test',
      ai: { enableThinking: true },
    });

    await form.emit('submit');

    expect(fetch).not.toHaveBeenCalled();
    expect(root.querySelector('#weekly-report-error')?.textContent).toContain('AI 配置不完整');
  });

  it.each([
    [false, 0, '无可用提交（未调用 AI）'],
    [true, 1, '历史本地结果'],
    [true, 0, '历史本地结果'],
  ])(
    'labels degraded=%s and commitCount=%s without claiming AI was called',
    async (degraded, commitCount, label) => {
      const { root, form, fetch } = mountWeeklyReport();
      queueSuccess(fetch, { ...RESULT, degraded, commitCount });

      await form.emit('submit');

      expect(root.querySelector('#weekly-report-meta')?.textContent).toContain(label);
      expect(root.querySelector('#weekly-report-meta')?.textContent).not.toContain('AI 摘要');
      expect(root.querySelector('#weekly-report-status')?.dataset.status).toBe('ready');
    },
  );

  it.each(['missing AI', 'create failure', 'AI job failure'])(
    'clears a previous report on %s and disables copy/download behavior',
    async (failure) => {
      const { root, form, fetch, storage, writeText, createObjectURL } = mountWeeklyReport();
      queueSuccess(fetch, {
        ...RESULT,
        projectErrors: [
          { repo: PROJECT.repo, repoLabel: 'old-project', code: 404, message: '旧项目异常' },
        ],
      });
      await form.emit('submit');
      expect(root.querySelector('#weekly-report-actions')?.hidden).toBe(false);
      expect(root.querySelector('#weekly-report-project-errors')?.hidden).toBe(false);

      if (failure === 'missing AI')
        storage.set(TOKEN_KEY, JSON.stringify({ githubToken: 'github-test' }));
      else if (failure === 'create failure') fetch.mockRejectedValueOnce(new Error('任务创建失败'));
      else
        fetch.mockResolvedValueOnce(response({ jobId: 'job-failed' })).mockResolvedValueOnce(
          response({
            status: 'failed',
            result: null,
            error: { message: 'AI 摘要无效' },
          }),
        );
      await form.emit('submit');
      await root.querySelector('#weekly-report-copy')?.emit('click');
      await root.querySelector('#weekly-report-download')?.emit('click');

      expect(fetch).toHaveBeenCalledTimes(
        failure === 'missing AI' ? 2 : failure === 'create failure' ? 3 : 4,
      );
      expect(root.querySelector('#weekly-report-output')?.textContent).toBe('');
      expect(root.querySelector('#weekly-report-output')?.hidden).toBe(true);
      expect(root.querySelector('#weekly-report-actions')?.hidden).toBe(true);
      expect(root.querySelector('#weekly-report-project-errors')?.hidden).toBe(true);
      expect(root.querySelector('#weekly-report-meta')?.textContent).toBe('未生成报告。');
      expect(root.querySelector('#weekly-report-status')?.dataset.status).toBe('error');
      expect(root.querySelector('#weekly-report-error')?.hidden).toBe(false);
      expect(root.querySelector('#weekly-report-submit')?.disabled).toBe(false);
      expect(writeText).not.toHaveBeenCalled();
      expect(createObjectURL).not.toHaveBeenCalled();
    },
  );
});
