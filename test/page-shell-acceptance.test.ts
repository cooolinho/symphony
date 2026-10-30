import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { after, before, describe, it } from 'node:test';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { page } from '../src/http/ui/layout.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';
import { SYMPHONY_VERSION } from '../src/version.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

// Independent acceptance tests for E1-3 (#342), derived from the issue text and exercised through the served HTML.

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;
const styles = (html: string): string => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] as string).join('\n');
const scripts = (html: string): string[] => [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
const navs = (html: string): string[] => [...html.matchAll(/<nav\b[^>]*>[\s\S]*?<\/nav>/g)].map((m) => m[0]);
const mainNav = (html: string): string => {
  const found = navs(html).filter((n) => /aria-label="Hauptnavigation"/.test(n));
  assert.equal(found.length, 1, 'exactly one main navigation');
  return found[0] as string;
};
const links = (nav: string): Array<{ href: string; text: string; current: boolean }> =>
  [...nav.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: /href="([^"]*)"/.exec(m[1] as string)?.[1] ?? '',
    text: (m[2] as string).replace(/<[^>]+>/g, '').trim(),
    current: /aria-current="page"/.test(m[1] as string),
  }));
/** CSS rule bodies whose selector list matches `selector` exactly (outside or inside media queries). */
const rules = (css: string, selector: string): string[] => {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) {
    const sels = (m[1] as string).split(',').map((s) => s.trim().replace(/^[\s\S]*\*\/\s*/, ''));
    if (sels.includes(selector)) out.push(m[2] as string);
  }
  return out;
};

describe('E1-3 page shell', () => {
  let server: HttpServerHandle;
  const pages: Record<string, string> = {};

  before(async () => {
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: tempDir(),
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(),
    });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    for (const [name, path] of [['dashboard', '/'], ['agent', '/agent'], ['logs', '/logs']] as const) {
      const res = await get(server.port, path);
      assert.equal(res.status, 200, path);
      pages[name] = res.body;
    }
  });

  after(async () => {
    await server.close();
  });

  describe('page() API', () => {
    const doc = page({ title: 'Titel <&> "x"', nav: 'brain', body: '<p id="probe">Inhalt</p>', scripts: 'window.__probe = 1;' });

    it('produces a complete HTML document with tokens CSS and BASE_JS', () => {
      assert.match(doc, /^<!doctype html>/i);
      assert.match(doc, /<html\b[^>]*>[\s\S]*<head>[\s\S]*<\/head>[\s\S]*<body[^>]*>[\s\S]*<\/body>[\s\S]*<\/html>/);
      assert.ok(doc.includes(TOKENS_CSS), 'tokens CSS embedded');
      assert.ok(doc.includes(BASE_JS), 'BASE_JS embedded');
      assert.ok(doc.includes('window.__probe = 1;'), 'page script embedded');
      assert.ok(doc.includes('<p id="probe">Inhalt</p>'), 'body embedded');
      assert.match(doc, /<meta name="viewport"/);
    });

    it('escapes the title', () => {
      const title = /<title>([\s\S]*?)<\/title>/.exec(doc)?.[1] ?? '';
      assert.ok(!/[<>"]/.test(title), title);
      assert.ok(title.includes('&lt;') && title.includes('&amp;'));
    });

    it('the body content sits after the header, the page script runs after BASE_JS', () => {
      assert.ok(doc.indexOf('id="probe"') > doc.indexOf('</header>'));
      assert.ok(doc.indexOf('window.__probe') > doc.indexOf(BASE_JS.slice(0, 80)));
    });

    it('marks exactly the requested entry as current, for every nav key; none for null', () => {
      const expected = { overview: 'Übersicht', changes: 'Changes', tasks: 'Tasks', brain: 'Brain', stats: 'Statistik' } as const;
      for (const [key, label] of Object.entries(expected)) {
        const html = page({ title: 't', nav: key as keyof typeof expected, body: '', scripts: '' });
        const current = links(mainNav(html)).filter((l) => l.current);
        assert.deepEqual(current.map((l) => l.text), [label], key);
      }
      const none = page({ title: 't', nav: null, body: '', scripts: '' });
      assert.equal(links(mainNav(none)).filter((l) => l.current).length, 0);
    });

    it('renders breadcrumbs only when crumbs are given', () => {
      assert.equal(count(doc, /aria-label="Brotkrumen"/g), 0);
      const withCrumbs = page({ title: 't', nav: null, crumbs: [{ label: 'Übersicht', href: '/' }, { label: 'Agent 3' }], body: '', scripts: '' });
      assert.equal(count(withCrumbs, /<nav\b[^>]*aria-label="Brotkrumen"/g), 1);
      const crumbNav = navs(withCrumbs).find((n) => n.includes('Brotkrumen')) as string;
      assert.ok(crumbNav.includes('Übersicht') && crumbNav.includes('Agent 3'));
      assert.equal(links(crumbNav).length, 1, 'only the parent crumb is a link');
      assert.equal(count(withCrumbs, /aria-label="Hauptnavigation"/g), 1, 'breadcrumbs are not a second main navigation');
    });

    it('escapes crumb labels', () => {
      const html = page({ title: 't', nav: null, crumbs: [{ label: '<script>alert(1)</script>' }], body: '', scripts: '' });
      assert.ok(!html.includes('<script>alert(1)</script>'));
    });
  });

  describe('header contents', () => {
    for (const name of ['dashboard', 'agent', 'logs']) {
      it(`${name}: exactly one <header> and one main navigation with five pills in order`, () => {
        const html = pages[name] as string;
        assert.equal(count(html, /<header\b/g), 1);
        assert.equal(count(html, /<\/header>/g), 1);
        assert.equal(count(html, /aria-label="Hauptnavigation"/g), 1);
        assert.equal(count(html, /<nav\b[^>]*Hauptnavigation/g), 1);
        const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
        assert.ok(header.includes('aria-label="Hauptnavigation"'), 'navigation lives inside the header');
        const ls = links(mainNav(html));
        assert.deepEqual(ls.map((l) => l.text), ['Übersicht', 'Changes', 'Tasks', 'Brain', 'Statistik']);
        assert.equal(ls[0]?.href, '/');
        assert.equal(ls[4]?.href, '/logs');
        for (const l of ls.slice(1, 4)) assert.match(l.href, /^\/[a-z]+/, l.text);
        assert.equal(new Set(ls.map((l) => l.href)).size, 5, 'distinct targets');
      });

      it(`${name}: no old top bar remains`, () => {
        const html = pages[name] as string;
        assert.ok(!/class="[^"]*\btopbar\b/.test(html));
        assert.ok(!/\.topbar\b/.test(styles(html)));
      });

      it(`${name}: header carries logo/name, LIVE, 5 h chip placeholder, version and clock`, () => {
        const html = pages[name] as string;
        const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
        assert.match(header, /Symphony/);
        assert.match(header, /LIVE|Live/);
        assert.ok(header.includes('5 h —'), '5 h placeholder');
        assert.ok(header.includes(SYMPHONY_VERSION), 'version from src/version.ts');
        assert.match(header, /<time\b|clock|Uhr/i);
      });

      it(`${name}: all page scripts still parse`, () => {
        const ss = scripts(pages[name] as string);
        assert.ok(ss.length > 0);
        for (const s of ss) assert.doesNotThrow(() => new vm.Script(s, { filename: `${name}.js` }));
      });
    }

    it('the version in the header comes from src/version.ts, as the old top bar did', () => {
      assert.match(SYMPHONY_VERSION, /^\d+\.\d+\.\d+/);
    });

    it('logo links to the overview', () => {
      for (const name of ['dashboard', 'agent', 'logs']) {
        const html = pages[name] as string;
        const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
        assert.match(header, /<a\b[^>]*href="\/"[^>]*>[\s\S]*?Symphony/);
      }
    });
  });

  describe('active entry and breadcrumbs per page', () => {
    it('dashboard: Übersicht is current and the only current entry', () => {
      const cur = links(mainNav(pages.dashboard as string)).filter((l) => l.current);
      assert.deepEqual(cur.map((l) => [l.text, l.href]), [['Übersicht', '/']]);
    });
    it('logs: Statistik is current and the only current entry', () => {
      const cur = links(mainNav(pages.logs as string)).filter((l) => l.current);
      assert.deepEqual(cur.map((l) => [l.text, l.href]), [['Statistik', '/logs']]);
    });
    it('agent: no main entry is current (the page is outside the navigation)', () => {
      assert.equal(links(mainNav(pages.agent as string)).filter((l) => l.current).length, 0);
    });
    it('breadcrumbs appear on the agent page only and lead back to the overview', () => {
      assert.equal(count(pages.agent as string, /<nav\b[^>]*aria-label="Brotkrumen"/g), 1);
      const crumb = navs(pages.agent as string).find((n) => n.includes('Brotkrumen')) as string;
      assert.ok(links(crumb).some((l) => l.href === '/' && l.text === 'Übersicht'));
      for (const name of ['dashboard', 'logs']) assert.ok(!(pages[name] as string).includes('Brotkrumen'), name);
    });
    it('each page has exactly one <main> and a document title', () => {
      for (const name of ['dashboard', 'agent', 'logs']) {
        const html = pages[name] as string;
        assert.equal(count(html, /<main\b/g), 1, name);
        assert.match(html, /<title>[^<]+<\/title>/, name);
        assert.match(html, /<html\b[^>]*lang="de"/, name);
      }
    });
  });

  describe('aurora and blur budget', () => {
    it('aurora is a fixed layer of two or three radial gradients without images', () => {
      for (const name of ['dashboard', 'agent', 'logs']) {
        const css = styles(pages[name] as string);
        const aurora = rules(css, '.aurora');
        assert.ok(aurora.length >= 1, `${name}: .aurora rule`);
        const body = aurora.join(';');
        assert.match(body, /position:\s*fixed/);
        const gradients = count(body, /radial-gradient\(/g);
        assert.ok(gradients >= 2 && gradients <= 3, `${name}: ${gradients} gradients`);
        assert.doesNotMatch(body, /url\(|<img/);
        assert.ok(!/<img\b/.test(pages[name] as string), `${name}: no images`);
      }
    });

    it('aurora element is decorative (hidden from assistive tech) and does not capture pointer events', () => {
      for (const name of ['dashboard', 'agent', 'logs']) {
        assert.match(pages[name] as string, /class="aurora"[^>]*aria-hidden="true"/, name);
        assert.match(rules(styles(pages[name] as string), '.aurora').join(';'), /pointer-events:\s*none/, name);
      }
    });

    it('at most four blur layers per page (counted backdrop-filter: blur declarations)', () => {
      for (const name of ['dashboard', 'agent', 'logs']) {
        const css = styles(pages[name] as string);
        const blurs = count(css.replace(/-webkit-backdrop-filter[^;}]*/g, ''), /backdrop-filter:\s*blur\(/g);
        assert.ok(blurs <= 4, `${name}: ${blurs} blur declarations`);
      }
    });

    it('the aurora layer itself does not blur', () => {
      const css = styles(pages.dashboard as string);
      assert.doesNotMatch(rules(css, '.aurora').join(';'), /blur|filter/);
    });
  });

  describe('responsive behaviour at 390 px and touch targets', () => {
    it('the navigation scrolls horizontally in its own frame', () => {
      for (const name of ['dashboard', 'agent', 'logs']) {
        const css = styles(pages[name] as string);
        const navClass = /<nav class="([^"]*)"[^>]*aria-label="Hauptnavigation"/.exec(pages[name] as string)?.[1]?.split(/\s+/)[0] as string;
        assert.ok(navClass, 'nav has a class');
        const r = rules(css, '.' + navClass).join(';');
        assert.match(r, /overflow-x:\s*auto/, `${name}: .${navClass}`);
      }
    });

    it('the page itself does not scroll horizontally', () => {
      const css = styles(pages.dashboard as string);
      const bodyRules = rules(css, 'body').concat(rules(css, 'html')).join(';');
      assert.match(bodyRules, /overflow-x:\s*(hidden|clip)/);
    });

    it('navigation pills, logo and breadcrumb links are at least 44 px high', () => {
      const html = pages.agent as string;
      const css = styles(html);
      const pill = /<a class="([^"]*)" href="\/changes"/.exec(html)?.[1]?.split(/\s+/)[0] as string;
      assert.ok(pill, 'pill class');
      assert.match(rules(css, '.' + pill).join(';'), /min-height:\s*(4[4-9]|[5-9]\d)px/);
      const brandClass = /<a class="([^"]*)" href="\/"[^>]*>\s*<span/.exec(html)?.[1]?.split(/\s+/)[0];
      assert.ok(brandClass, 'brand class');
      assert.match(rules(css, '.' + brandClass).join(';'), /min-height:\s*(4[4-9]|[5-9]\d)px/);
      assert.match(rules(css, '.crumbs a').join(';'), /min-height:\s*(4[4-9]|[5-9]\d)px/);
    });

    it('a narrow-viewport media query exists for the shell', () => {
      const css = styles(pages.dashboard as string);
      assert.match(css, /@media\s*\(max-width:\s*(4\d\d|5\d\d|6\d\d|7\d\d)px\)/);
    });
  });

  describe('accessibility and motion', () => {
    it('the active pill is styled via aria-current', () => {
      assert.match(styles(pages.dashboard as string), /\[aria-current=["']?page["']?\]/);
    });
    it('reduced transparency and reduced motion remain supported', () => {
      const css = styles(pages.dashboard as string);
      assert.match(css, /prefers-reduced-transparency:\s*reduce/);
      assert.match(css, /prefers-reduced-motion:\s*reduce/);
    });
    it('keyboard focus stays visible for links', () => {
      assert.match(styles(pages.logs as string), /a:focus-visible/);
    });
    it('the shell loads no external resources', () => {
      for (const name of ['dashboard', 'agent', 'logs']) {
        assert.doesNotMatch(styles(pages[name] as string), /https?:\/\/|@import|url\(\s*["']?https?:/, name);
        assert.doesNotMatch(pages[name] as string, /<(script|link)\b[^>]*(src|href)="https?:\/\//, name);
      }
    });
  });

  describe('German texts', () => {
    it('shell labels are German and no English remnants of the old top bar remain', () => {
      for (const name of ['dashboard', 'agent', 'logs']) {
        const html = pages[name] as string;
        const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
        const text = header.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
        for (const english of ['Overview', 'Statistics', 'Dashboard', 'Logs', 'Clock', 'Breadcrumb']) assert.ok(!text.includes(english), `${name}: ${english}`);
        assert.ok(text.includes('Übersicht') && text.includes('Statistik'));
        for (const term of ['Changes', 'Tasks', 'Brain']) assert.ok(text.includes(term));
      }
      assert.ok(pages.agent!.includes('Brotkrumen'));
    });
  });

  describe('page behaviour moved with the top bar still works', () => {
    // Ids the pages' own scripts address by literal id must still exist in the markup.
    for (const name of ['dashboard', 'agent', 'logs']) {
      it(`${name}: every statically addressed element id exists in the markup`, () => {
        const html = pages[name] as string;
        const markup = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
        const ss = scripts(html).join('\n');
        const wanted = new Set<string>();
        for (const m of ss.matchAll(/getElementById\(\s*'([\w-]+)'\s*\)/g)) wanted.add(m[1] as string);
        for (const m of ss.matchAll(/(?<![\w.])\$\(\s*'([\w-]+)'\s*\)/g)) wanted.add(m[1] as string);
        const created = (id: string): boolean => new RegExp(`id\\s*[:=]\\s*['"]${id}['"]|['"]${id}['"]\\s*\\)?\\s*;?\\s*//\\s*dyn|setAttribute\\(\\s*'id'\\s*,\\s*'${id}'`).test(ss);
        const missing = [...wanted].filter((id) => !markup.includes(`id="${id}"`) && !created(id));
        assert.deepEqual(missing, []);
      });
    }

    it('the dashboard keeps its actions: Poll now and the logs opener', () => {
      const html = pages.dashboard as string;
      assert.match(html, /id="refresh"/);
      assert.match(html, /id="logs-open"/);
    });

    it('the logs page keeps Raw log and Reload', () => {
      const html = pages.logs as string;
      assert.match(html, /id="raw"/);
      assert.match(html, /id="reload"/);
    });

    it('the poll progress strip is still present on every page', () => {
      for (const name of ['dashboard', 'agent', 'logs']) assert.match(pages[name] as string, /id="progress"/, name);
    });
  });

  describe('routes', () => {
    it('the pages still answer with HTML', async () => {
      for (const path of ['/', '/agent', '/logs']) {
        const res = await get(server.port, path);
        assert.equal(res.status, 200);
        assert.match(res.body, /^<!doctype html>/i);
      }
    });
  });
});
