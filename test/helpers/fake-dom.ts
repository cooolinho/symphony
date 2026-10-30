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
    this.children = [];
    this.own = String(v);
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML must not be used for data');
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
      else this.children.push(n);
    }
  }
  appendChild(n: FakeElement): FakeElement {
    this.children.push(n);
    return n;
  }
  replaceChildren(...nodes: (FakeElement | string)[]): void {
    this.children = [];
    this.own = '';
    this.append(...nodes);
  }
  descendants(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  find(pred: (e: FakeElement) => boolean): FakeElement[] {
    return this.descendants().filter(pred);
  }
}

/** A document with createElement (XHTML) and createElementNS. */
export function createFakeDocument() {
  return {
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
  };
}

/** A vm context with the fake document in which the given scripts have run; function declarations land on it. */
export function scriptContext(...sources: string[]): vm.Context {
  const ctx = vm.createContext({ document: createFakeDocument() });
  for (const src of sources) vm.runInContext(src, ctx);
  return ctx;
}
