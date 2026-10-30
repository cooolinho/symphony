import vm from 'node:vm';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** Minimal DOM element: attributes, classList, style custom properties, children and text; innerHTML is forbidden. */
export class FakeElement {
  tagName: string;
  namespaceURI: string;
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  private own = '';
  private props = new Map<string, string>();
  style: Record<string, unknown> & { setProperty(k: string, v: string): void; getPropertyValue(k: string): string };
  classList = {
    add: (...c: string[]) => this.setClasses([...new Set([...this.classes(), ...c])]),
    remove: (...c: string[]) => this.setClasses(this.classes().filter((x) => !c.includes(x))),
    contains: (c: string) => this.classes().includes(c),
    [Symbol.iterator]: () => this.classes()[Symbol.iterator](),
    toggle: (c: string) => (this.classList.contains(c) ? this.classList.remove(c) : this.classList.add(c)),
  };

  constructor(tagName: string, namespaceURI = XHTML_NS) {
    this.tagName = tagName;
    this.namespaceURI = namespaceURI;
    this.style = {
      setProperty: (k: string, v: string) => void this.props.set(k, String(v)),
      getPropertyValue: (k: string) => this.props.get(k) ?? '',
    };
  }
  private classes(): string[] {
    return (this.attributes.get('class') ?? '').split(/\s+/).filter(Boolean);
  }
  private setClasses(list: string[]): void {
    this.attributes.set('class', list.join(' '));
  }
  get className(): string {
    return this.attributes.get('class') ?? '';
  }
  set className(v: string) {
    this.attributes.set('class', v);
  }
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.detachChildren();
    this.own = String(v);
  }
  /** Own text of this element (without the children). */
  get ownText(): string {
    return this.own;
  }
  set ownText(v: string) {
    this.own = v;
  }
  parentNode: FakeElement | null = null;
  get parentElement(): FakeElement | null {
    return this.parentNode;
  }
  /** Child elements; own text counts as one leading text node, like in a browser. */
  get childNodes(): FakeElement[] {
    if (!this.own) return this.children;
    const text = new FakeElement('#text');
    text.own = this.own;
    return [text, ...this.children];
  }
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get lastElementChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }
  private detachChildren(): void {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
  }
  private adopt(n: FakeElement): FakeElement {
    n.remove();
    n.parentNode = this;
    return n;
  }
  remove(): void {
    const p = this.parentNode;
    if (p) p.children = p.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  removeChild(n: FakeElement): FakeElement {
    n.remove();
    return n;
  }
  insertBefore(n: FakeElement, ref: FakeElement | null): FakeElement {
    this.adopt(n);
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(n);
    else this.children.splice(at, 0, n);
    return n;
  }
  replaceChild(n: FakeElement, old: FakeElement): FakeElement {
    this.adopt(n);
    const at = this.children.indexOf(old);
    if (at < 0) this.children.push(n);
    else {
      this.children[at]!.parentNode = null;
      this.children[at] = n;
    }
    return old;
  }
  contains(n: FakeElement | null): boolean {
    for (let c: FakeElement | null = n; c; c = c.parentNode) if (c === this) return true;
    return false;
  }
  closest(sel: string): FakeElement | null {
    for (let c: FakeElement | null = this; c; c = c.parentNode) if (c.matches(sel)) return c;
    return null;
  }
  matches(sel: string): boolean {
    return matchesSelector(this, sel);
  }
  querySelectorAll(sel: string): FakeElement[] {
    return this.descendants().filter((e) => e.matches(sel));
  }
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  get id(): string {
    return this.attributes.get('id') ?? '';
  }
  set id(v: string) {
    this.attributes.set('id', String(v));
  }
  private mirror(k: string): string {
    return this.attributes.get(k) ?? '';
  }
  get href(): string {
    return this.mirror('href');
  }
  set href(v: string) {
    this.attributes.set('href', String(v));
  }
  get title(): string {
    return this.mirror('title');
  }
  set title(v: string) {
    this.attributes.set('title', String(v));
  }
  get type(): string {
    return this.mirror('type');
  }
  set type(v: string) {
    this.attributes.set('type', String(v));
  }
  get target(): string {
    return this.mirror('target');
  }
  set target(v: string) {
    this.attributes.set('target', String(v));
  }
  get rel(): string {
    return this.mirror('rel');
  }
  set rel(v: string) {
    this.attributes.set('rel', String(v));
  }
  private flag(k: string, v: boolean): void {
    if (v) this.attributes.set(k, '');
    else this.attributes.delete(k);
  }
  get hidden(): boolean {
    return this.attributes.has('hidden');
  }
  set hidden(v: boolean) {
    this.flag('hidden', !!v);
  }
  get open(): boolean {
    return this.attributes.has('open');
  }
  set open(v: boolean) {
    this.flag('open', !!v);
  }
  get disabled(): boolean {
    return this.attributes.has('disabled');
  }
  set disabled(v: boolean) {
    this.flag('disabled', !!v);
  }
  get dataset(): Record<string, string> {
    const key = (k: string) => 'data-' + k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    return new Proxy({} as Record<string, string>, {
      get: (_t, k) => (typeof k === 'string' ? this.attributes.get(key(k)) : undefined),
      set: (_t, k, v) => (typeof k === 'string' && this.attributes.set(key(k), String(v)), true),
      has: (_t, k) => typeof k === 'string' && this.attributes.has(key(k)),
      deleteProperty: (_t, k) => (typeof k === 'string' && this.attributes.delete(key(k)), true),
    });
  }
  private typed: string | null = null;
  get value(): string {
    if (this.typed !== null) return this.typed;
    if (this.tagName === 'select') {
      const options = this.querySelectorAll('option');
      const chosen = options.find((o) => o.hasAttribute('selected')) ?? options[0];
      return chosen ? chosen.getAttribute('value') ?? chosen.textContent : '';
    }
    return this.attributes.get('value') ?? '';
  }
  set value(v: string) {
    this.typed = String(v);
  }
  scrollTop = 0;
  offsetWidth = 0;
  scrollHeight = 0;
  clientHeight = 0;
  scrollIntoView(): void {}
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  get outerHTML(): string {
    const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
    const esc = this.own.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<${this.tagName}${attrs}>${esc}${this.children.map((c) => c.outerHTML).join('')}</${this.tagName}>`;
  }
  /** Elements of a parsed page document accept innerHTML (the pages use it for static icons only). */
  lenientHtml = false;
  set innerHTML(v: string) {
    if (!this.lenientHtml) throw new Error('innerHTML must not be used for data');
    const parsed = parseHtml(v);
    this.detachChildren();
    this.own = parsed.ownText;
    for (const c of [...parsed.children]) this.appendChild(c);
  }
  set outerHTML(_v: string) {
    throw new Error('outerHTML must not be used for data');
  }
  insertAdjacentHTML(): void {
    throw new Error('insertAdjacentHTML must not be used for data');
  }
  setAttribute(k: string, v: unknown): void {
    this.attributes.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attributes.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attributes.has(k);
  }
  removeAttribute(k: string): void {
    this.attributes.delete(k);
  }
  append(...nodes: (FakeElement | string)[]): void {
    for (const n of nodes) {
      if (typeof n === 'string') this.own += n;
      else this.children.push(this.adopt(n));
    }
  }
  appendChild(n: FakeElement): FakeElement {
    this.children.push(this.adopt(n));
    return n;
  }
  replaceChildren(...nodes: (FakeElement | string)[]): void {
    this.detachChildren();
    this.own = '';
    this.append(...nodes);
  }
  descendants(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  find(pred: (e: FakeElement) => boolean): FakeElement[] {
    return this.descendants().filter(pred);
  }
  byClass(name: string): FakeElement[] {
    return this.find((e) => e.classList.contains(name));
  }
  private listeners = new Map<string, Array<(event: object) => void>>();
  addEventListener(type: string, fn: (event: object) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** Runs the listeners of type on this element; props (e.g. key, target) are merged into the event. */
  dispatch(type: string, props: Record<string, unknown> = {}): void {
    const event: Record<string, any> = { type, target: this, currentTarget: this, preventDefault: () => {}, stopPropagation: () => (event.stopped = true), ...props };
    for (let node: FakeElement | null = this; node; node = props.bubbles && !event.stopped ? node.parentNode : null) {
      event.currentTarget = node;
      for (const fn of node.listeners.get(type) ?? []) fn(event);
    }
  }
  click(): void {
    this.dispatch('click');
  }
  /** The element that got the focus last (focus() of any FakeElement). */
  static active: FakeElement | null = null;
  focus(): void {
    FakeElement.active = this;
  }
  get tabIndex(): number {
    return Number(this.attributes.get('tabindex') ?? -1);
  }
  set tabIndex(v: number) {
    this.attributes.set('tabindex', String(v));
  }
}

type Compound = { tag?: string; id?: string; classes: string[]; attrs: Array<[string, string | null]> };

function parseCompound(src: string): Compound {
  const c: Compound = { classes: [], attrs: [] };
  const re = /^([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/y;
  let rest = src;
  while (rest) {
    const m = re.exec(rest);
    if (!m) throw new Error(`unsupported selector: ${src}`);
    if (m[1]) c.tag = m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else c.attrs.push([m[4]!, m[5] ?? m[6] ?? m[7] ?? null]);
    rest = rest.slice(m[0].length);
    re.lastIndex = 0;
  }
  return c;
}

function matchesCompound(e: FakeElement, c: Compound): boolean {
  return (
    (!c.tag || e.tagName.toLowerCase() === c.tag) &&
    (!c.id || e.id === c.id) &&
    c.classes.every((k) => e.classList.contains(k)) &&
    c.attrs.every(([k, v]) => (v === null ? e.hasAttribute(k) : e.getAttribute(k) === v))
  );
}

/** Selector subset the pages use: comma groups, descendant combinator, tag, #id, .class, [attr] and [attr="v"]. */
function matchesSelector(e: FakeElement, selector: string): boolean {
  const groups = selector.match(/(?:[^,"]|"[^"]*")+/g) ?? [];
  return groups.some((group) => {
    const parts = (group.trim().match(/(?:[^\s"]|"[^"]*")+/g) ?? []).map(parseCompound);
    if (!parts.length || !matchesCompound(e, parts.pop()!)) return false;
    let node = e.parentNode;
    while (parts.length && node) {
      if (matchesCompound(node, parts[parts.length - 1]!)) parts.pop();
      node = node.parentNode;
    }
    return parts.length === 0;
  });
}

const VOID_TAGS = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'col', 'source', 'wbr', 'path', 'line', 'circle', 'rect']);

const decodeEntities = (v: string) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Parses served page HTML into a FakeElement tree; <script> and <style> contents are skipped. */
export function parseHtml(html: string): FakeElement {
  const root = new FakeElement('#document');
  const stack: FakeElement[] = [root];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1]!;
    if (m[5] !== undefined) {
      top.ownText += decodeEntities(m[5]);
    } else if (m[1]) {
      const tag = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tagName === tag) {
          stack.length = i;
          break;
        }
      }
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const node = new FakeElement(tag);
      for (const a of m[3]!.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        node.setAttribute(a[1]!, decodeEntities(a[2] ?? a[3] ?? a[4] ?? ''));
      }
      top.appendChild(node);
      if (tag === 'script' || tag === 'style') {
        const end = html.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
        re.lastIndex = end < 0 ? html.length : html.indexOf('>', end) + 1;
      } else if (!VOID_TAGS.has(tag) && !m[4]) stack.push(node);
    }
  }
  return root;
}

/** A document with createElement (XHTML) and createElementNS; with a parsed tree also lookups, body and root listeners. */
export function createFakeDocument(root?: FakeElement) {
  const make = (tag: string, ns?: string) => {
    const e = new FakeElement(tag, ns);
    e.lenientHtml = root !== undefined;
    return e;
  };
  const doc = {
    createElement: (tag: string) => make(tag),
    createElementNS: (ns: string, tag: string) => make(tag, ns),
  };
  const full = doc as typeof doc & Record<string, any>;
  if (!root) return full;
  const find = (tag: string) => root.querySelector(tag) ?? root;
  Object.assign(full, {
    getElementById: (id: string) => root.querySelector(`#${id}`),
    querySelector: (sel: string) => root.querySelector(sel),
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
    get body() {
      return find('body');
    },
    get documentElement() {
      return find('html');
    },
    title: root.querySelector('title')?.textContent ?? '',
    referrer: '',
    hidden: false,
    get activeElement() {
      return FakeElement.active ?? find('body');
    },
    addEventListener: (type: string, fn: (event: object) => void) => root.addEventListener(type, fn),
    dispatch: (type: string, props?: Record<string, unknown>) => root.dispatch(type, props),
  });
  return full;
}

/** A vm context with the fake document in which the given scripts have run; function declarations land on it. */
export function scriptContext(...sources: string[]): vm.Context {
  const ctx = vm.createContext({ document: createFakeDocument() });
  for (const src of sources) vm.runInContext(src, ctx);
  return ctx;
}

export const createDocument = createFakeDocument;
export const domContext = scriptContext;
export const run = (ctx: vm.Context, code: string): any => vm.runInContext(code, ctx);
