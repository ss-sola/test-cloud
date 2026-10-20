import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/* ------------------------------------------------------------------ *
 * 最小 DOM 桩：仅覆盖 content-compare.js 会用到的节点、选择器与事件能力。
 * 页面结构直接解析 public/html 下的真实模板，保证脚本依赖的 id / data 属性与 HTML 一致。
 * ------------------------------------------------------------------ */

type Listener = ((event: FakeEvent) => void) | { handleEvent(event: FakeEvent): void };

class FakeEvent {
  defaultPrevented = false;
  target: FakeHTMLElement | null = null;
  currentTarget: FakeHTMLElement | null = null;
  propagationStopped = false;
  readonly detail: unknown;
  readonly bubbles: boolean;

  constructor(
    readonly type: string,
    init: { detail?: unknown; bubbles?: boolean } = {},
  ) {
    this.detail = init.detail;
    this.bubbles = init.bubbles ?? true;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

abstract class FakeNode {
  parentNode: FakeParent | null = null;
  abstract get textContent(): string;
  abstract set textContent(value: string);
}

class FakeText extends FakeNode {
  constructor(public data: string) {
    super();
  }

  get textContent(): string {
    return this.data;
  }

  set textContent(value: string) {
    this.data = value;
  }
}

abstract class FakeParent extends FakeNode {
  readonly childNodes: FakeNode[] = [];

  get children(): FakeHTMLElement[] {
    return this.childNodes.filter(
      (node): node is FakeHTMLElement => node instanceof FakeHTMLElement,
    );
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value: string) {
    this.replaceChildren(...(value === '' ? [] : [value]));
  }

  append(...nodes: (FakeNode | string)[]): void {
    const incoming = this.adopt(nodes);
    this.childNodes.push(...incoming);
  }

  prepend(...nodes: (FakeNode | string)[]): void {
    const incoming = this.adopt(nodes);
    this.childNodes.unshift(...incoming);
  }

  appendChild<T extends FakeNode>(node: T): T {
    this.append(node);
    return node;
  }

  removeChild<T extends FakeNode>(node: T): T {
    this.detach(node);
    return node;
  }

  replaceChildren(...nodes: (FakeNode | string)[]): void {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    this.append(...nodes);
  }

  querySelectorAll(selector: string): FakeHTMLElement[] {
    const list = parseSelectorList(selector);
    return descendants(this).filter((element) =>
      list.some((steps) => matchSteps(element, steps, steps.length - 1)),
    );
  }

  querySelector(selector: string): FakeHTMLElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  private adopt(nodes: (FakeNode | string)[]): FakeNode[] {
    const incoming = nodes.flatMap((node) => {
      if (typeof node === 'string') return [new FakeText(node)];
      if (node instanceof FakeFragment) return node.drain();
      return [node];
    });
    for (const node of incoming) {
      node.parentNode?.detach(node);
      node.parentNode = this;
    }
    return incoming;
  }

  private detach(node: FakeNode): void {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
  }
}

class FakeFragment extends FakeParent {
  /** 取出并清空全部子节点，模拟 DocumentFragment 被插入后的搬移行为。 */
  drain(): FakeNode[] {
    const nodes = [...this.childNodes];
    for (const node of nodes) node.parentNode = null;
    this.childNodes.length = 0;
    return nodes;
  }
}

function descendants(parent: FakeParent): FakeHTMLElement[] {
  const result: FakeHTMLElement[] = [];
  for (const child of parent.childNodes) {
    if (child instanceof FakeHTMLElement) result.push(child, ...descendants(child));
  }
  return result;
}

const toDataAttribute = (name: string): string =>
  `data-${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;

class FakeHTMLElement extends FakeParent {
  scrollTop = 0;
  scrollLeft = 0;
  readonly style = {
    setProperty(this: Record<string, unknown>, name: string, value: string): void {
      this[name] = value;
    },
    removeProperty(this: Record<string, unknown>, name: string): void {
      delete this[name];
    },
  } as Record<string, unknown>;
  readonly dataset: Record<string, string | undefined> = new Proxy(
    {} as Record<string, string | undefined>,
    {
      get: (_target, prop) =>
        typeof prop === 'string'
          ? (this.getAttribute(toDataAttribute(prop)) ?? undefined)
          : undefined,
      set: (_target, prop, value) => {
        if (typeof prop === 'string') this.setAttribute(toDataAttribute(prop), String(value));
        return true;
      },
      has: (_target, prop) => typeof prop === 'string' && this.hasAttribute(toDataAttribute(prop)),
      deleteProperty: (_target, prop) => {
        if (typeof prop === 'string') this.removeAttribute(toDataAttribute(prop));
        return true;
      },
    },
  );
  readonly classList = {
    add: (...tokens: string[]): void => this.writeClasses([...this.readClasses(), ...tokens]),
    remove: (...tokens: string[]): void =>
      this.writeClasses(this.readClasses().filter((token) => !tokens.includes(token))),
    contains: (token: string): boolean => this.readClasses().includes(token),
    toggle: (token: string, force?: boolean): boolean => {
      const has = this.readClasses().includes(token);
      const next = force ?? !has;
      if (next && !has) this.classList.add(token);
      if (!next && has) this.classList.remove(token);
      return next;
    },
  };
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly tagName: string) {
    super();
  }

  get ownerDocument(): unknown {
    return fakeDocument;
  }

  get parentElement(): FakeHTMLElement | null {
    return this.parentNode instanceof FakeHTMLElement ? this.parentNode : null;
  }

  get id(): string {
    return this.attributes.get('id') ?? '';
  }

  set id(value: string) {
    this.attributes.set('id', value);
  }

  get className(): string {
    return this.attributes.get('class') ?? '';
  }

  set className(value: string) {
    this.attributes.set('class', value);
  }

  get hidden(): boolean {
    return this.attributes.has('hidden');
  }

  set hidden(value: boolean) {
    if (value) this.attributes.set('hidden', '');
    else this.attributes.delete('hidden');
  }

  get disabled(): boolean {
    return this.attributes.has('disabled');
  }

  set disabled(value: boolean) {
    if (value) this.attributes.set('disabled', '');
    else this.attributes.delete('disabled');
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const next = force ?? !this.attributes.has(name);
    if (next) this.attributes.set(name, '');
    else this.attributes.delete(name);
    return next;
  }

  matches(selector: string): boolean {
    return parseSelectorList(selector).some((steps) => matchSteps(this, steps, steps.length - 1));
  }

  closest(selector: string): FakeHTMLElement | null {
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  focus(): void {}

  blur(): void {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }

  /** 派发事件并向上冒泡；与浏览器一致，禁用按钮不会响应 click。 */
  dispatchEvent(event: FakeEvent): boolean {
    if (event.type === 'click' && this.disabled) return true;
    event.target ??= this;
    const notify = (element: FakeHTMLElement) => {
      event.currentTarget = element;
      for (const listener of element.listeners.get(event.type) ?? []) {
        if (typeof listener === 'function') listener.call(element, event);
        else listener.handleEvent(event);
      }
    };
    notify(this);
    for (
      let parent = this.parentElement;
      parent && event.bubbles && !event.propagationStopped;
      parent = parent.parentElement
    ) {
      notify(parent);
    }
    return !event.defaultPrevented;
  }

  set innerHTML(value: string) {
    if (value !== '')
      throw new Error('innerHTML with markup is not supported; build nodes with createElement');
    this.replaceChildren();
  }

  get innerHTML(): string {
    throw new Error('innerHTML getter is not supported');
  }

  private readClasses(): string[] {
    return this.className.split(/\s+/).filter(Boolean);
  }

  private writeClasses(tokens: string[]): void {
    this.className = [...new Set(tokens)].join(' ');
  }
}

class FakeTextArea extends FakeHTMLElement {
  value = '';
  placeholder = '';

  constructor() {
    super('TEXTAREA');
  }
}

class FakeButton extends FakeHTMLElement {
  constructor() {
    super('BUTTON');
  }

  get type(): string {
    return this.getAttribute('type') ?? 'submit';
  }

  set type(value: string) {
    this.setAttribute('type', value);
  }
}

function createElement(tag: string): FakeHTMLElement {
  const name = tag.toLowerCase();
  if (name === 'textarea') return new FakeTextArea();
  if (name === 'button') return new FakeButton();
  return new FakeHTMLElement(name.toUpperCase());
}

const fakeDocument = {
  body: new FakeHTMLElement('BODY'),
  createElement,
  createDocumentFragment: (): FakeFragment => new FakeFragment(),
  createTextNode: (text: string): FakeText => new FakeText(text),
  querySelector: (): null => null,
  querySelectorAll: (): never[] => [],
  getElementById: (): null => null,
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
};

/* ----------------------------- 选择器 ----------------------------- */

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: { name: string; value: string | null }[];
}

interface SelectorStep {
  combinator: ' ' | '>';
  compound: Compound;
}

const COMPOUND_PART =
  /^(?:([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\])/;

function parseCompound(text: string): Compound {
  const compound: Compound = { tag: null, id: null, classes: [], attrs: [] };
  let rest = text;
  while (rest) {
    const match = COMPOUND_PART.exec(rest);
    if (!match) throw new Error(`Unsupported selector in FakeDOM: ${text}`);
    if (match[1]) compound.tag = match[1] === '*' ? null : match[1].toUpperCase();
    else if (match[2]) compound.id = match[2];
    else if (match[3]) compound.classes.push(match[3]);
    else compound.attrs.push({ name: match[4], value: match[5] ?? match[6] ?? match[7] ?? null });
    rest = rest.slice(match[0].length);
  }
  return compound;
}

function parseSelectorList(selector: string): SelectorStep[][] {
  return selector.split(',').map((part) =>
    [...part.trim().matchAll(/(>)?\s*([^\s>]+)/g)].map((match) => ({
      combinator: match[1] ? ('>' as const) : (' ' as const),
      compound: parseCompound(match[2]),
    })),
  );
}

function matchCompound(element: FakeHTMLElement, compound: Compound): boolean {
  if (compound.tag && element.tagName !== compound.tag) return false;
  if (compound.id && element.id !== compound.id) return false;
  if (!compound.classes.every((name) => element.classList.contains(name))) return false;
  return compound.attrs.every(
    (attr) =>
      element.hasAttribute(attr.name) &&
      (attr.value === null || element.getAttribute(attr.name) === attr.value),
  );
}

function matchSteps(element: FakeHTMLElement, steps: SelectorStep[], index: number): boolean {
  const step = steps[index];
  if (!matchCompound(element, step.compound)) return false;
  if (index === 0) return true;
  if (step.combinator === '>') {
    const parent = element.parentElement;
    return parent !== null && matchSteps(parent, steps, index - 1);
  }
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (matchSteps(parent, steps, index - 1)) return true;
  }
  return false;
}

/* ----------------------------- HTML 模板解析 ----------------------------- */

const HTML_TOKEN =
  /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
const HTML_ATTRIBUTE = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

const decodeEntities = (text: string): string =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** 把 public/html 下的片段解析成 FakeDOM，并返回首个顶层元素。 */
function parseHtml(html: string): FakeHTMLElement {
  const holder = new FakeFragment();
  const stack: FakeParent[] = [holder];
  for (const token of html.matchAll(HTML_TOKEN)) {
    const [whole, closing, opening, attributes, selfClosing, text] = token;
    const top = stack[stack.length - 1];
    if (closing) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        const candidate = stack[i];
        if (candidate instanceof FakeHTMLElement && candidate.tagName === closing.toUpperCase()) {
          stack.length = i;
          break;
        }
      }
    } else if (opening) {
      const element = createElement(opening);
      for (const attr of attributes.matchAll(HTML_ATTRIBUTE)) {
        element.setAttribute(attr[1], decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? ''));
      }
      top.append(element);
      if (!selfClosing && !VOID_TAGS.has(opening.toLowerCase())) stack.push(element);
    } else if (text !== undefined && !whole.startsWith('<!--') && text.trim()) {
      top.append(decodeEntities(text));
    }
  }
  const root = holder.children[0];
  if (!root) throw new Error('HTML template has no root element');
  holder.removeChild(root);
  return root;
}

/* ----------------------------- 存储与网络桩 ----------------------------- */

class FakeStorage {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

interface RecordedRequest {
  path: string;
  method: string;
  credentials: string | undefined;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
  /** 发起请求那一刻 localStorage 中的草稿，用于校验“先保存后请求”。 */
  storedDraft: unknown;
  respond(status: number, payload: unknown): void;
  respondText(status: number, text: string, contentType?: string): void;
  fail(error: Error): void;
}

type Settle = (request: RecordedRequest) => void;

function createAbortError(): Error {
  const Ctor = (globalThis as { DOMException?: new (message: string, name: string) => Error })
    .DOMException;
  if (Ctor) return new Ctor('The operation was aborted.', 'AbortError');
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const iterable = headers as {
    forEach?: (callback: (value: string, key: string) => void) => void;
  };
  const result: Record<string, string> = {};
  if (typeof iterable.forEach === 'function') {
    iterable.forEach((value, key) => {
      result[key.toLowerCase()] = value;
    });
    return result;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>))
    result[key.toLowerCase()] = String(value);
  return result;
}

function createResponse(status: number, text: string, contentType: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  };
}

/* ----------------------------- 页面夹具 ----------------------------- */

const MAX_DRAFT_LENGTH = 500_000;

interface ViewConfig {
  prefix: 'json' | 'env';
  file: string;
  key: string;
  endpoint: string;
  /** 用户输入的原文。 */
  doc(value: number): string;
  /** 后端返回的 leftText / rightText。 */
  normalized(value: number): string;
  /** 后端 segments 所覆盖的文本。 */
  highlighted(value: number): string;
}

const VIEWS = {
  'json-compare': {
    prefix: 'json',
    file: 'json-compare.html',
    key: 'nestcloud:compare:json:v1',
    endpoint: '/api/content-compare/json',
    doc: (value) => `{"a":${value}}`,
    normalized: (value) => `{\n  "a": ${value}\n}`,
    highlighted: (value) => `{\n  "a": ${value}\n}`,
  },
  'env-compare': {
    prefix: 'env',
    file: 'env-compare.html',
    key: 'nestcloud:compare:env:v1',
    endpoint: '/api/content-compare/env',
    doc: (value) => `export A=${value}`,
    normalized: (value) => `A=${value}`,
    highlighted: (value) => `export A=${value}`,
  },
} satisfies Record<string, ViewConfig>;

type ViewName = keyof typeof VIEWS;
type Side = 'a' | 'b';

interface DiffSegment {
  text: string;
  status: 'modified' | null;
}

function splitSegments(text: string, changed: string): DiffSegment[] {
  const index = text.lastIndexOf(changed);
  return [
    { text: text.slice(0, index), status: null as null },
    { text: changed, status: 'modified' as const },
    { text: text.slice(index + changed.length), status: null as null },
  ].filter((segment) => segment.text !== '');
}

/** 构造后端 200 响应：left / right 为 1 位数字，segments 中的变化片段即该数字。 */
function okBody(view: ViewName, left: number, right: number) {
  const config = VIEWS[view];
  return {
    code: 200,
    message: 'ok',
    data: {
      leftText: config.normalized(left),
      rightText: config.normalized(right),
      tree: {
        key: '$',
        path: '$',
        hasLeft: true,
        hasRight: true,
        type: 'object',
        status: 'modified',
        leftDisplay: '{ 1 个键 }',
        rightDisplay: '{ 1 个键 }',
        children: [],
      },
      stats: { added: 1, removed: 2, modified: 3 },
      segments: {
        left: splitSegments(config.highlighted(left), String(left)),
        right: splitSegments(config.highlighted(right), String(right)),
      },
    },
  };
}

interface ParseError {
  code: string;
  message: string;
  line?: number;
  column?: number;
  previousLine?: number;
}

function errorBody(errors: { left?: ParseError[]; right?: ParseError[] }) {
  return {
    code: 400,
    message: '内容解析失败',
    data: null,
    errors: { left: errors.left ?? [], right: errors.right ?? [] },
  };
}

const leftError: ParseError = {
  code: 'INVALID',
  message: '左侧第 2 行内容无效',
  line: 2,
  column: 5,
};
const rightError: ParseError = {
  code: 'INVALID',
  message: '右侧第 3 行内容无效',
  line: 3,
  column: 1,
};

const flush = async (): Promise<void> => {
  await new Promise<void>((done) => setImmediate(done));
  await new Promise<void>((done) => setImmediate(done));
};

interface MountOptions {
  stored?: string | { left: string; right: string };
  /** 为 false 时模拟“响应已在途、abort 对其无效”的竞态；默认与浏览器一致，abort 会令 fetch 以 AbortError 拒绝。 */
  honorAbort?: boolean;
}

const COMPARE_SCRIPT = readFileSync(
  resolve(__dirname, '../../public/js/content-compare.js'),
  'utf8',
);

class Harness {
  readonly storage = new FakeStorage();
  readonly requests: RecordedRequest[] = [];
  readonly root: FakeHTMLElement;
  readonly config: ViewConfig;

  /** 在隔离的 vm 上下文中执行新脚本并挂载真实 HTML 模板；fetch 仅为可控桩，不会访问网络。 */
  constructor(
    readonly view: ViewName,
    options: MountOptions = {},
  ) {
    this.config = VIEWS[view];
    const { stored, honorAbort = true } = options;
    if (stored !== undefined) {
      this.storage.setItem(
        this.config.key,
        typeof stored === 'string'
          ? stored
          : JSON.stringify({ version: 1, left: stored.left, right: stored.right, updatedAt: 1 }),
      );
    }

    const fetchStub = (input: unknown, init: Record<string, unknown> = {}): Promise<unknown> =>
      new Promise((resolveFetch, rejectFetch) => {
        const signal = init.signal as AbortSignal | undefined;
        const request: RecordedRequest = {
          path: new URL(String(input), 'http://localhost').pathname,
          method: String(init.method ?? 'GET'),
          credentials: init.credentials as string | undefined,
          headers: normalizeHeaders(init.headers),
          body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body,
          signal,
          storedDraft: JSON.parse(this.storage.getItem(this.config.key) ?? 'null') as unknown,
          respond: (status, payload) =>
            resolveFetch(createResponse(status, JSON.stringify(payload), 'application/json')),
          respondText: (status, text, contentType = 'text/plain') =>
            resolveFetch(createResponse(status, text, contentType)),
          fail: (error) => rejectFetch(error),
        };
        this.requests.push(request);
        if (honorAbort && signal) {
          if (signal.aborted) rejectFetch(createAbortError());
          else signal.addEventListener('abort', () => rejectFetch(createAbortError()));
        }
      });

    const globals = globalThis as Record<string, unknown>;
    const sandbox: Record<string, unknown> = {
      document: fakeDocument,
      localStorage: this.storage,
      fetch: fetchStub,
      HTMLElement: FakeHTMLElement,
      Element: FakeHTMLElement,
      HTMLTextAreaElement: FakeTextArea,
      HTMLButtonElement: FakeButton,
      Node: FakeNode,
      Text: FakeText,
      DocumentFragment: FakeFragment,
      Event: FakeEvent,
      CustomEvent: FakeEvent,
      AbortController,
      DOMException: globals.DOMException,
      Headers: globals.Headers,
      URL,
      setTimeout,
      clearTimeout,
      queueMicrotask,
      requestAnimationFrame: (callback: () => void) => {
        queueMicrotask(callback);
        return 0;
      },
      cancelAnimationFrame: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    };
    sandbox.window = sandbox;
    runInContext(COMPARE_SCRIPT, createContext(sandbox));

    const api = sandbox.NestCloudContentCompare as
      | { mount(root: FakeHTMLElement): unknown }
      | undefined;
    if (!api) throw new Error('window.NestCloudContentCompare was not exported');
    this.root = parseHtml(
      readFileSync(resolve(__dirname, '../../public/html', this.config.file), 'utf8'),
    );
    if (this.root.dataset.view !== view) throw new Error('Comparison fragment view does not match');
    api.mount(this.root);
  }

  el(selector: string): FakeHTMLElement {
    const element = this.root.querySelector(selector);
    if (!element) throw new Error(`Missing element ${selector}`);
    return element;
  }

  textarea(side: Side): FakeTextArea {
    return this.el(`#${this.config.prefix}-${side}`) as FakeTextArea;
  }

  get left(): FakeTextArea {
    return this.textarea('a');
  }

  get right(): FakeTextArea {
    return this.textarea('b');
  }

  get compareButton(): FakeHTMLElement {
    return this.el(`[data-compare-action="${this.config.prefix}"]`);
  }

  get swapButton(): FakeHTMLElement {
    return this.el(`[data-compare-swap="${this.config.prefix}"]`);
  }

  get draft(): unknown {
    return JSON.parse(this.storage.getItem(this.config.key) ?? 'null') as unknown;
  }

  get resultVisible(): boolean {
    return !this.el(`#${this.config.prefix}-result`).hidden;
  }

  get busy(): { busy: boolean; compareDisabled: boolean; swapDisabled: boolean } {
    return {
      busy: this.root.getAttribute('aria-busy') === 'true',
      compareDisabled: this.compareButton.disabled,
      swapDisabled: this.swapButton.disabled,
    };
  }

  /** 页面上所有可见 role=alert 的文本。 */
  get alertText(): string {
    return this.root
      .querySelectorAll('[role="alert"]')
      .filter((element) => !element.hidden)
      .map((element) => element.textContent.trim())
      .join(' ')
      .trim();
  }

  error(side: Side): { visible: boolean; text: string } {
    const element = this.el(`#${this.config.prefix}-${side}-error`);
    return { visible: !element.hidden, text: element.textContent };
  }

  highlight(side: Side): string {
    return this.el(`#${this.config.prefix}-${side}-highlight code`).textContent;
  }

  highlightedSpans(side: Side): string[] {
    return this.el(`#${this.config.prefix}-${side}-highlight code`)
      .children.filter((span) => /added|removed|modified/.test(span.className))
      .map((span) => span.textContent);
  }

  stat(name: 'added' | 'removed' | 'modified'): string {
    return this.el(`#${this.config.prefix}-${name}-count`).textContent;
  }

  async type(side: Side, value: string): Promise<void> {
    const textarea = this.textarea(side);
    textarea.value = value;
    textarea.dispatchEvent(new FakeEvent('input'));
    await flush();
  }

  async click(target: 'compare' | 'swap'): Promise<void> {
    (target === 'compare' ? this.compareButton : this.swapButton).dispatchEvent(
      new FakeEvent('click'),
    );
    await flush();
  }

  async settle(index: number, action: Settle): Promise<void> {
    action(this.requests[index]);
    await flush();
  }

  async respond(index: number, status: number, payload: unknown): Promise<void> {
    await this.settle(index, (request) => request.respond(status, payload));
  }

  /* oxlint-disable vitest/no-standalone-expect -- 用例通过共享夹具复用 DOM 验收断言。 */
  /** 校验后端 200 结果已按 segments 渲染到高亮层、统计与差异树。 */
  expectRendered(left: number, right: number): void {
    expect(this.resultVisible).toBe(true);
    expect(this.highlight('a')).toBe(this.config.highlighted(left));
    expect(this.highlight('b')).toBe(this.config.highlighted(right));
    expect(this.highlightedSpans('a')).toEqual([String(left)]);
    expect(this.highlightedSpans('b')).toEqual([String(right)]);
    expect([this.stat('added'), this.stat('removed'), this.stat('modified')]).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(this.el(`#${this.config.prefix}-tree`).textContent).toContain('{ 1 个键 }');
  }

  expectNoResult(): void {
    expect(this.resultVisible).toBe(false);
    expect(this.highlight('a')).toBe('');
    expect(this.highlight('b')).toBe('');
  }

  expectNoErrors(): void {
    expect(this.error('a').visible).toBe(false);
    expect(this.error('b').visible).toBe(false);
    expect(this.alertText).toBe('');
  }
  /* oxlint-enable vitest/no-standalone-expect */
}

const failures: [string, Settle][] = [
  ['400 response', (request) => request.respond(400, errorBody({ left: [leftError] }))],
  ['network failure', (request) => request.fail(new TypeError('Failed to fetch'))],
];

describe.each(Object.keys(VIEWS) as ViewName[])('content compare page (%s)', (view) => {
  const config = VIEWS[view];
  const stored = { left: config.doc(1), right: config.doc(2) };

  describe('mount and drafts', () => {
    it('restores the saved draft into both editors without sending any request', async () => {
      const harness = new Harness(view, { stored });
      await flush();

      expect(harness.left.value).toBe(config.doc(1));
      expect(harness.right.value).toBe(config.doc(2));
      expect(harness.el(`#${config.prefix}-a-count`).textContent).toContain(
        String(config.doc(1).length),
      );
      expect(harness.el(`#${config.prefix}-b-count`).textContent).toContain(
        String(config.doc(2).length),
      );
      expect(harness.requests).toHaveLength(0);
      expect(harness.resultVisible).toBe(false);
      expect(harness.busy.busy).toBe(false);
    });

    it('restores a draft whose sides are exactly at the length limit', () => {
      const edge = { left: 'x'.repeat(MAX_DRAFT_LENGTH), right: 'y'.repeat(MAX_DRAFT_LENGTH) };
      const harness = new Harness(view, { stored: edge });

      expect(harness.left.value).toBe(edge.left);
      expect(harness.right.value).toBe(edge.right);
    });

    it.each([
      ['corrupted JSON', '{broken'],
      ['unknown version', JSON.stringify({ version: 2, left: 'x', right: 'y', updatedAt: 1 })],
      ['non-string side', JSON.stringify({ version: 1, left: 'x', right: 1, updatedAt: 1 })],
      [
        'oversized side',
        JSON.stringify({
          version: 1,
          left: 'x'.repeat(MAX_DRAFT_LENGTH + 1),
          right: 'y',
          updatedAt: 1,
        }),
      ],
    ])('ignores an unusable saved draft (%s)', (_name, raw) => {
      const harness = new Harness(view, { stored: raw });

      expect(harness.left.value).toBe('');
      expect(harness.right.value).toBe('');
    });

    it('saves ordinary typing as a versioned draft and never uploads it', async () => {
      const harness = new Harness(view);

      await harness.type('a', config.doc(1));
      await harness.type('b', config.doc(2));

      expect(harness.draft).toEqual({
        version: 1,
        left: config.doc(1),
        right: config.doc(2),
        updatedAt: expect.any(Number),
      });
      expect(harness.el(`#${config.prefix}-a-count`).textContent).toContain(
        String(config.doc(1).length),
      );
      expect(harness.requests).toHaveLength(0);
    });

    it('does not overwrite the saved draft when an editor exceeds the length limit', async () => {
      const harness = new Harness(view, { stored });

      await harness.type('a', 'x'.repeat(MAX_DRAFT_LENGTH + 1));

      expect(harness.draft).toMatchObject(stored);
      expect(harness.requests).toHaveLength(0);
    });
  });

  describe('compare request', () => {
    it('posts both editors on one click and stays busy until the response settles', async () => {
      const harness = new Harness(view, { stored });

      await harness.click('compare');

      expect(harness.requests).toHaveLength(1);
      const [request] = harness.requests;
      expect(request).toMatchObject({
        path: config.endpoint,
        method: 'POST',
        credentials: 'same-origin',
      });
      expect(request.headers['content-type']).toContain('application/json');
      expect(request.body).toEqual({ left: config.doc(1), right: config.doc(2) });
      expect(harness.busy).toEqual({ busy: true, compareDisabled: true, swapDisabled: false });

      await harness.click('compare'); // 按钮已禁用，重复点击不得再发请求
      expect(harness.requests).toHaveLength(1);

      await harness.respond(0, 200, okBody(view, 1, 2));
      expect(harness.busy).toEqual({ busy: false, compareDisabled: false, swapDisabled: false });
    });

    it('clears the previous input errors as soon as a new comparison starts', async () => {
      const harness = new Harness(view, { stored });
      await harness.click('compare');
      await harness.respond(0, 400, errorBody({ left: [leftError], right: [rightError] }));
      expect(harness.error('a').visible).toBe(true);
      expect(harness.error('b').visible).toBe(true);

      await harness.click('compare');

      harness.expectNoErrors();
      expect(harness.busy.busy).toBe(true);
    });

    it.each([
      ['left only', { left: [leftError] }],
      ['right only', { right: [rightError] }],
      ['both sides', { left: [leftError], right: [rightError] }],
    ])(
      'shows 400 errors per side (%s), keeps the original text and clears the previous result',
      async (_name, errors) => {
        const harness = new Harness(view, { stored });
        await harness.click('compare');
        await harness.respond(0, 200, okBody(view, 1, 2));
        harness.expectRendered(1, 2);
        const left = harness.left.value;
        const right = harness.right.value;

        await harness.click('compare');
        await harness.respond(1, 400, errorBody(errors));

        const expectedLeft = (errors as { left?: ParseError[] }).left?.[0];
        const expectedRight = (errors as { right?: ParseError[] }).right?.[0];
        expect(harness.error('a').visible).toBe(Boolean(expectedLeft));
        expect(harness.error('b').visible).toBe(Boolean(expectedRight));
        expect(harness.error('a').text).toContain(expectedLeft?.message ?? '');
        expect(harness.error('b').text).toContain(expectedRight?.message ?? '');
        expect(harness.left.value).toBe(left);
        expect(harness.right.value).toBe(right);
        harness.expectNoResult();
        expect(harness.busy).toEqual({ busy: false, compareDisabled: false, swapDisabled: false });
      },
    );

    it.each([
      [
        'network failure',
        (request: RecordedRequest) => request.fail(new TypeError('Failed to fetch')),
      ],
      [
        'non-JSON gateway error',
        (request: RecordedRequest) =>
          request.respondText(502, '<html><body>Bad Gateway</body></html>', 'text/html'),
      ],
      [
        '200 response that is not JSON',
        (request: RecordedRequest) => request.respondText(200, 'OK', 'text/plain'),
      ],
    ])(
      'clears the old result on %s, reports it without raw markup and allows a retry',
      async (_name, fail) => {
        const harness = new Harness(view, { stored });
        await harness.click('compare');
        await harness.respond(0, 200, okBody(view, 1, 2));
        harness.expectRendered(1, 2);
        const left = harness.left.value;

        await harness.click('compare');
        await harness.settle(1, fail);

        harness.expectNoResult();
        expect(harness.busy).toEqual({ busy: false, compareDisabled: false, swapDisabled: false });
        expect(harness.alertText).not.toBe('');
        expect(harness.alertText).not.toContain('<html>');
        expect(harness.left.value).toBe(left);

        await harness.click('compare');
        expect(harness.requests).toHaveLength(3);
        await harness.respond(2, 200, okBody(view, 1, 2));
        harness.expectRendered(1, 2);
        expect(harness.alertText).toBe('');
      },
    );
  });

  describe('input cancels the running comparison', () => {
    it('aborts the request, clears the old result and does not send a new one', async () => {
      const harness = new Harness(view, { stored });
      await harness.click('compare');
      await harness.respond(0, 200, okBody(view, 1, 2));
      harness.expectRendered(1, 2);

      await harness.click('compare');
      await harness.type('a', config.doc(3));

      expect(harness.requests).toHaveLength(2);
      expect(harness.requests[1].signal?.aborted).toBe(true);
      harness.expectNoResult();
      harness.expectNoErrors();
      expect(harness.busy).toEqual({ busy: false, compareDisabled: false, swapDisabled: false });
      expect(harness.left.value).toBe(config.doc(3));
    });

    it.each([
      ['success', (request: RecordedRequest) => request.respond(200, okBody(view, 1, 2))],
      [
        '400 response',
        (request: RecordedRequest) => request.respond(400, errorBody({ left: [leftError] })),
      ],
      [
        'network failure',
        (request: RecordedRequest) => request.fail(new TypeError('Failed to fetch')),
      ],
    ])('ignores a late %s from the cancelled request', async (_name, late) => {
      const harness = new Harness(view, { stored, honorAbort: false });
      await harness.click('compare');
      await harness.type('a', config.doc(3));

      await harness.settle(0, late);

      expect(harness.left.value).toBe(config.doc(3));
      expect(harness.right.value).toBe(config.doc(2));
      expect(harness.draft).toMatchObject({ left: config.doc(3), right: config.doc(2) });
      harness.expectNoResult();
      harness.expectNoErrors();
      expect(harness.busy).toEqual({ busy: false, compareDisabled: false, swapDisabled: false });
      expect(harness.requests).toHaveLength(1);
    });
  });

  describe('swap', () => {
    it('saves the swapped drafts before sending the new comparison when idle', async () => {
      const harness = new Harness(view, { stored });

      await harness.click('swap');

      expect(harness.left.value).toBe(config.doc(2));
      expect(harness.right.value).toBe(config.doc(1));
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0].path).toBe(config.endpoint);
      expect(harness.requests[0].body).toEqual({ left: config.doc(2), right: config.doc(1) });
      expect(harness.requests[0].storedDraft).toMatchObject({
        left: config.doc(2),
        right: config.doc(1),
      });
      expect(harness.busy).toEqual({ busy: true, compareDisabled: true, swapDisabled: false });
    });

    it('is allowed while a request is running: aborts the old call, sends the swapped body and stays busy for the new one', async () => {
      const harness = new Harness(view, { stored });
      await harness.click('compare');

      await harness.click('swap');

      expect(harness.requests).toHaveLength(2);
      expect(harness.requests[0].signal?.aborted).toBe(true);
      expect(harness.requests[1].body).toEqual({ left: config.doc(2), right: config.doc(1) });
      expect(harness.requests[1].storedDraft).toMatchObject({
        left: config.doc(2),
        right: config.doc(1),
      });
      // 旧请求以 AbortError 结束，不得清除新请求的繁忙状态，也不得提示错误
      expect(harness.busy).toEqual({ busy: true, compareDisabled: true, swapDisabled: false });
      expect(harness.alertText).toBe('');

      await harness.respond(1, 200, okBody(view, 2, 1));
      harness.expectRendered(2, 1);
      expect(harness.busy).toEqual({ busy: false, compareDisabled: false, swapDisabled: false });
    });

    it.each(failures)(
      'keeps the swapped request busy when the old %s arrives late',
      async (_name, late) => {
        const harness = new Harness(view, { stored, honorAbort: false });
        await harness.click('compare');
        await harness.click('swap');

        await harness.settle(0, late);

        expect(harness.busy).toEqual({ busy: true, compareDisabled: true, swapDisabled: false });
        harness.expectNoErrors();

        await harness.respond(1, 200, okBody(view, 2, 1));
        harness.expectRendered(2, 1);
        harness.expectNoErrors();
        expect(harness.busy).toEqual({ busy: false, compareDisabled: false, swapDisabled: false });
      },
    );

    it.each(failures)(
      'keeps the new result when the old %s arrives after the swapped request succeeded',
      async (_name, late) => {
        const harness = new Harness(view, { stored, honorAbort: false });
        await harness.click('compare');
        await harness.click('swap');
        await harness.respond(1, 200, okBody(view, 2, 1));

        await harness.settle(0, late);

        harness.expectRendered(2, 1);
        harness.expectNoErrors();
        expect(harness.busy).toEqual({ busy: false, compareDisabled: false, swapDisabled: false });
      },
    );

    it('clears the error state at once on swap and then shows the new response errors on the swapped sides', async () => {
      const harness = new Harness(view, { stored });
      await harness.click('compare');
      await harness.respond(0, 400, errorBody({ left: [leftError] }));
      expect(harness.error('a').visible).toBe(true);

      await harness.click('swap');

      harness.expectNoErrors();
      expect(harness.requests[1].body).toEqual({ left: config.doc(2), right: config.doc(1) });

      await harness.respond(1, 400, errorBody({ right: [rightError] }));
      expect(harness.error('a').visible).toBe(false);
      expect(harness.error('b').visible).toBe(true);
      expect(harness.error('b').text).toContain(rightError.message);
    });
  });
});

describe('JSON compare success', () => {
  it('backfills the normalized text from the response, persists it and renders backend segments', async () => {
    const harness = new Harness('json-compare', {
      stored: { left: VIEWS['json-compare'].doc(1), right: VIEWS['json-compare'].doc(2) },
    });

    await harness.click('compare');
    await harness.respond(0, 200, okBody('json-compare', 1, 2));

    expect(harness.left.value).toBe('{\n  "a": 1\n}');
    expect(harness.right.value).toBe('{\n  "a": 2\n}');
    expect(harness.draft).toMatchObject({
      version: 1,
      left: '{\n  "a": 1\n}',
      right: '{\n  "a": 2\n}',
    });
    expect(harness.el('#json-a-count').textContent).toContain(String('{\n  "a": 1\n}'.length));
    expect(harness.highlight('a')).toBe(harness.left.value);
    expect(harness.highlight('b')).toBe(harness.right.value);
    harness.expectRendered(1, 2);
  });
});

describe('ENV compare success', () => {
  it('keeps the original ENV text even when the response carries normalized text', async () => {
    const harness = new Harness('env-compare', {
      stored: { left: VIEWS['env-compare'].doc(1), right: VIEWS['env-compare'].doc(2) },
    });

    await harness.click('compare');
    await harness.respond(0, 200, okBody('env-compare', 1, 2));

    expect(harness.left.value).toBe('export A=1');
    expect(harness.right.value).toBe('export A=2');
    expect(harness.draft).toMatchObject({ version: 1, left: 'export A=1', right: 'export A=2' });
    expect(harness.highlight('a')).toBe('export A=1');
    harness.expectRendered(1, 2);
  });
});
