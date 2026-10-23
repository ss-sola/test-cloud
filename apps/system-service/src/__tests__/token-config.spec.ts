import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

type Listener = (event: { preventDefault(): void }) => void;

class FakeHTMLElement {
  textContent = '';
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** 触发已注册的监听器，并返回是否调用过 preventDefault。 */
  emit(type: string): boolean {
    let prevented = false;
    const event = {
      preventDefault: () => {
        prevented = true;
      },
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return prevented;
  }
}

class FakeInput extends FakeHTMLElement {
  value = '';
  type = 'text';
  checked = false;
}

class FakeCheckbox extends FakeInput {
  type = 'checkbox';
}

class FakeForm extends FakeHTMLElement {}

class FakeButton extends FakeHTMLElement {}

class FakeCustomEvent {
  constructor(readonly type: string) {}
}

class FakeStorage {
  readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

class FakeRoot extends FakeHTMLElement {
  readonly elements: Record<string, FakeHTMLElement> = {
    '#token-config-form': new FakeForm(),
    '#token-github': new FakeInput(),
    '#token-feishu-app-id': new FakeInput(),
    '#token-feishu-app-secret': new FakeInput(),
    '#token-ai-base-url': new FakeInput(),
    '#token-ai-api-key': new FakeInput(),
    '#token-ai-model': new FakeInput(),
    '#token-ai-enable-thinking': new FakeCheckbox(),
    '#token-config-clear': new FakeButton(),
    '#token-config-status': new FakeHTMLElement(),
  };

  querySelector(selector: string): FakeHTMLElement | null {
    return this.elements[selector] ?? null;
  }

  input(id: string): FakeInput {
    return this.elements[`#token-${id}`] as FakeInput;
  }

  get thinking(): FakeInput {
    return this.elements['#token-ai-enable-thinking'] as FakeInput;
  }

  get form(): FakeHTMLElement {
    return this.elements['#token-config-form'];
  }

  get clearButton(): FakeHTMLElement {
    return this.elements['#token-config-clear'];
  }

  get status(): string {
    return this.elements['#token-config-status'].textContent;
  }
}

interface TokenConfigHarness {
  root: FakeRoot;
  storage: FakeStorage;
  events: FakeCustomEvent[];
}

const TOKEN_KEY = 'nestcloud:release-tokens:v1';
const WEEKLY_KEY = 'nestcloud:weekly-report:v1';
const PREVIEW_KEY = 'nestcloud:config-file-preview:v1';
const SCRIPT = readFileSync(resolve(__dirname, '../../public/js/token-config.js'), 'utf8');

/** 在隔离的 vm 上下文中执行脚本并挂载表单；上下文不提供 fetch，确保不会发起网络请求。 */
function mountTokenConfig(initial: Record<string, string> = {}): TokenConfigHarness {
  const storage = new FakeStorage();
  for (const [key, value] of Object.entries(initial)) storage.setItem(key, value);
  const events: FakeCustomEvent[] = [];
  const window = {
    localStorage: storage,
    dispatchEvent: (event: FakeCustomEvent) => {
      events.push(event);
      return true;
    },
  } as Record<string, unknown>;
  const context = createContext({
    window,
    document: {},
    HTMLElement: FakeHTMLElement,
    HTMLFormElement: FakeForm,
    HTMLInputElement: FakeInput,
    HTMLButtonElement: FakeButton,
    CustomEvent: FakeCustomEvent,
  });
  runInContext(SCRIPT, context);
  const root = new FakeRoot();
  const api = window.NestCloudTokenConfig as { mount(target: FakeRoot): unknown };
  expect(api.mount(root)).toBeTruthy();
  return { root, storage, events };
}

const aiFields = ['ai-base-url', 'ai-api-key', 'ai-model'] as const;

describe('token config page', () => {
  let legacy: string;

  beforeEach(() => {
    legacy = JSON.stringify({
      githubToken: 'ghp_old',
      jenkinsBaseUrl: 'https://jenkins.example.com',
      jenkinsToken: 'jenkins-secret',
      feishuAppId: 'cli_old',
      feishuAppSecret: 'feishu-secret',
      ai: { baseUrl: 'https://ai.example.com/v1', apiKey: 'sk-old', model: 'gpt-old' },
    });
  });

  it('restores GitHub, Feishu and AI values from legacy storage that still contains Jenkins', () => {
    const { root } = mountTokenConfig({ [TOKEN_KEY]: legacy });

    expect(root.input('github').value).toBe('ghp_old');
    expect(root.input('feishu-app-id').value).toBe('cli_old');
    expect(root.input('feishu-app-secret').value).toBe('feishu-secret');
    expect(root.input('ai-base-url').value).toBe('https://ai.example.com/v1');
    expect(root.input('ai-api-key').value).toBe('sk-old');
    expect(root.input('ai-model').value).toBe('gpt-old');
    expect(root.status).toBe('已从当前浏览器恢复');
  });

  it('overwrites storage with current fields only, drops Jenkins and notifies listeners', () => {
    const { root, storage, events } = mountTokenConfig({ [TOKEN_KEY]: legacy });
    root.input('github').value = 'ghp_new';
    root.input('feishu-app-id').value = '  cli_new  ';

    expect(root.form.emit('submit')).toBe(true);

    expect(JSON.parse(storage.getItem(TOKEN_KEY) ?? '')).toEqual({
      githubToken: 'ghp_new',
      feishuAppId: 'cli_new',
      feishuAppSecret: 'feishu-secret',
      ai: {
        baseUrl: 'https://ai.example.com/v1',
        apiKey: 'sk-old',
        model: 'gpt-old',
        enableThinking: false,
      },
    });
    expect(storage.getItem(TOKEN_KEY)).not.toMatch(/jenkins/i);
    expect(events.map((event) => event.type)).toEqual(['nestcloud:tokens-updated']);
  });

  it('clears only the token key and keeps weekly report and config preview drafts', () => {
    const weekly = JSON.stringify({ repositories: ['a/b'] });
    const preview = JSON.stringify({ branch: 'main' });
    const { root, storage, events } = mountTokenConfig({
      [TOKEN_KEY]: legacy,
      [WEEKLY_KEY]: weekly,
      [PREVIEW_KEY]: preview,
    });

    root.clearButton.emit('click');

    expect(storage.getItem(TOKEN_KEY)).toBeNull();
    expect(storage.getItem(WEEKLY_KEY)).toBe(weekly);
    expect(storage.getItem(PREVIEW_KEY)).toBe(preview);
    for (const id of ['github', 'feishu-app-id', 'feishu-app-secret', ...aiFields]) {
      expect(root.input(id).value).toBe('');
    }
    expect(events.map((event) => event.type)).toEqual(['nestcloud:tokens-updated']);
    expect(root.status).toBe('凭据已清空');
  });

  it('saves a complete AI config trimmed and reports AI summary as enabled', () => {
    const { root, storage } = mountTokenConfig();
    root.input('ai-base-url').value = ' https://ai.example.com/v1 ';
    root.input('ai-api-key').value = ' sk-new ';
    root.input('ai-model').value = ' gpt-new ';

    root.form.emit('submit');

    expect(JSON.parse(storage.getItem(TOKEN_KEY) ?? '').ai).toEqual({
      baseUrl: 'https://ai.example.com/v1',
      apiKey: 'sk-new',
      model: 'gpt-new',
      enableThinking: false,
    });
    expect(root.status).toContain('AI 摘要已启用');
  });

  it('saves a draft without AI fields and warns that weekly reports cannot be generated', () => {
    const { root, storage } = mountTokenConfig();
    root.input('github').value = 'ghp_only';
    root.input('ai-model').value = '   ';

    root.form.emit('submit');

    const saved = JSON.parse(storage.getItem(TOKEN_KEY) ?? '') as Record<string, unknown>;
    expect(saved.githubToken).toBe('ghp_only');
    expect(saved).not.toHaveProperty('ai');
    expect(root.status).toContain('尚未配置 AI');
    expect(root.status).toContain('无法生成周报');
    expect(root.status).not.toContain('本地规则摘要');
  });

  it('keeps a partially filled AI config but warns that it is incomplete', () => {
    const { root, storage } = mountTokenConfig();
    root.input('ai-base-url').value = 'https://ai.example.com/v1';

    root.form.emit('submit');

    expect(JSON.parse(storage.getItem(TOKEN_KEY) ?? '').ai).toEqual({
      baseUrl: 'https://ai.example.com/v1',
      apiKey: '',
      model: '',
      enableThinking: false,
    });
    expect(root.status).toContain('AI 配置不完整');
    expect(root.status).toContain('无法生成周报');
  });

  it('keeps AI thinking off by default, restores only a stored true, and treats legacy or invalid values as off', () => {
    expect(mountTokenConfig().root.thinking.checked).toBe(false);
    expect(mountTokenConfig({ [TOKEN_KEY]: legacy }).root.thinking.checked).toBe(false);
    for (const invalid of ['true', 1, 'on', null, {}]) {
      const raw = JSON.stringify({
        ai: { baseUrl: 'https://a.example', apiKey: 'k', model: 'm', enableThinking: invalid },
      });
      expect(mountTokenConfig({ [TOKEN_KEY]: raw }).root.thinking.checked).toBe(false);
    }
    const on = JSON.stringify({
      ai: { baseUrl: 'https://a.example', apiKey: 'k', model: 'm', enableThinking: true },
    });
    expect(mountTokenConfig({ [TOKEN_KEY]: on }).root.thinking.checked).toBe(true);
  });

  it('saves the thinking switch as a real boolean without affecting AI completeness', () => {
    const { root, storage } = mountTokenConfig({ [TOKEN_KEY]: legacy });
    root.thinking.checked = true;
    root.form.emit('submit');
    expect(JSON.parse(storage.getItem(TOKEN_KEY) ?? '').ai.enableThinking).toBe(true);
    expect(root.status).toContain('AI 摘要已启用');

    root.thinking.checked = false;
    root.form.emit('submit');
    expect(JSON.parse(storage.getItem(TOKEN_KEY) ?? '').ai.enableThinking).toBe(false);
    expect(root.status).toContain('AI 摘要已启用');
  });

  it('reports AI as not configured when only the thinking switch is on', () => {
    const { root, storage } = mountTokenConfig();
    root.thinking.checked = true;
    root.form.emit('submit');
    expect(JSON.parse(storage.getItem(TOKEN_KEY) ?? '').ai).toEqual({
      baseUrl: '',
      apiKey: '',
      model: '',
      enableThinking: true,
    });
    expect(root.status).toContain('尚未配置 AI');
    expect(root.status).not.toContain('AI 摘要已启用');
  });

  it('clears the thinking switch together with credentials', () => {
    const on = JSON.stringify({
      ai: { baseUrl: 'https://a.example', apiKey: 'k', model: 'm', enableThinking: true },
    });
    const { root } = mountTokenConfig({ [TOKEN_KEY]: on });
    root.clearButton.emit('click');
    expect(root.thinking.checked).toBe(false);
  });

  it('declares an unchecked, labelled and described thinking checkbox in the page markup', () => {
    const html = readFileSync(resolve(__dirname, '../../public/html/token-config.html'), 'utf8');
    const input = html.match(/<input id="token-ai-enable-thinking"[^>]*>/)?.[0] ?? '';
    expect(input).toContain('type="checkbox"');
    expect(input).not.toMatch(/\bchecked\b/);
    expect(input).toContain('aria-describedby="token-ai-enable-thinking-hint"');
    expect(html).toContain('for="token-ai-enable-thinking"');
    expect(html).toMatch(
      /id="token-ai-enable-thinking-hint"[^>]*>[^<]*默认关闭[^<]*enable_thinking/,
    );
  });

  it('shows empty values and a not-saved status when nothing is stored', () => {
    const { root, events } = mountTokenConfig();

    expect(root.input('github').value).toBe('');
    expect(root.input('ai-model').value).toBe('');
    expect(root.status).toBe('尚未保存');
    expect(events).toHaveLength(0);
  });

  it.each([
    ['invalid JSON', '{broken'],
    ['null payload', 'null'],
    ['non-object payload', '"text"'],
    ['wrong field types', JSON.stringify({ githubToken: 1, feishuAppId: {}, ai: 'x' })],
  ])('restores empty values from a corrupted cache (%s)', (_name, raw) => {
    const { root } = mountTokenConfig({ [TOKEN_KEY]: raw });

    for (const id of ['github', 'feishu-app-id', 'feishu-app-secret', ...aiFields]) {
      expect(root.input(id).value).toBe('');
    }
  });
});
