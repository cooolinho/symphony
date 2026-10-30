/**
 * Minimal fake DOM for running the inline client scripts (BASE_JS, UI components) in a node:vm context.
 * Covers element creation, children, text, attributes, classList, style, click listeners and tree queries.
 * innerHTML / insertAdjacentHTML throw on purpose, so a script that uses them for data fails its test.
 */
import vm from 'node:vm';

export class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  text: string;
  constructor(text: string) {
    this.text = text;
  }
  get textContent(): string {
    return this.text;
  }
}

export type FakeNode = FakeElement | FakeText;
type Listener = (event: { type: string; target: FakeElement; currentTarget: FakeElement; preventDefault(): void }) => void;

export class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  className = '';
  style: Record<string, string> = {};
  childNodes: FakeNode[] = [];
  parentNode: FakeElement | null = null;
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Listener[]>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement);
  }

  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value: unknown) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    if (value !== '' && value !== null && value !== undefined) this.append(String(value));
  }

  set innerHTML(_value: string) {
    throw new Error('innerHTML is not allowed');
  }

  get innerHTML(): string {
    throw new Error('innerHTML is not allowed');
  }

  insertAdjacentHTML(): never {
    throw new Error('insertAdjacentHTML is not allowed');
  }

  append(...nodes: Array<FakeNode | string>): void {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeText(node) : node;
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  setAttribute(name: string, value: unknown): void {
    this.attrs.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  readonly classList = {
    add: (...names: string[]): void => {
      for (const name of names) if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim();
    },
    remove: (...names: string[]): void => {
      this.className = this.className.split(/\s+/).filter((c) => c && !names.includes(c)).join(' ');
    },
    contains: (name: string): boolean => this.className.split(/\s+/).includes(name),
    toggle: (name: string): boolean => {
      const has = this.classList.contains(name);
      if (has) this.classList.remove(name);
      else this.classList.add(name);
      return !has;
    },
  };

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  click(): void {
    for (const fn of this.listeners.get('click') ?? []) {
      fn({ type: 'click', target: this, currentTarget: this, preventDefault: () => {} });
    }
  }

  remove(): void {
    const parent = this.parentNode;
    if (parent) parent.childNodes = parent.childNodes.filter((node) => node !== this);
    this.parentNode = null;
  }

  /** All descendant elements (depth-first) matching the predicate. */
  find(pred: (el: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) {
      if (pred(child)) out.push(child);
      out.push(...child.find(pred));
    }
    return out;
  }

  /** All descendant elements carrying the class. */
  byClass(name: string): FakeElement[] {
    return this.find((el) => el.classList.contains(name));
  }
}

export function createDocument() {
  return {
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (ns: string, tag: string) => {
      const el = new FakeElement(tag);
      el.namespaceURI = ns;
      return el;
    },
    createTextNode: (text: string) => new FakeText(text),
  };
}

/** vm context with a fake `document`; runs the sources in order (e.g. BASE_JS) in that shared scope. */
export function domContext(...sources: string[]): vm.Context {
  const ctx = vm.createContext({ document: createDocument() });
  for (const source of sources) vm.runInContext(source, ctx);
  return ctx;
}

export const run = (ctx: vm.Context, code: string): any => vm.runInContext(code, ctx);
