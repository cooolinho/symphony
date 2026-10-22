import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/log.ts';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentExtension,
  downloadAttachment,
  extractAttachmentLinks,
  isUploadUrl,
  webOrigin,
} from '../src/tracker/github-project/attachments.ts';
import { githubProjectFactory } from '../src/tracker/github-project/index.ts';
import type { IssueAttachment } from '../src/tracker/types.ts';
import { ATTACHMENTS_DIR, writeAttachments } from '../src/workspace/attachments.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { makeIssue, tempDir } from './helpers.ts';

const ORIGIN = 'https://github.com';
const SIGNED = 'https://private-user-images.githubusercontent.com/1/2-abc.png?jwt=eyJ.x.y&amp;v=1';

/** A fake `fetch` that answers by URL and records every request with its authorization header. */
function fakeFetch(routes: Record<string, () => Response>) {
  const requests: Array<{ url: string; authorization: string | null; redirect: RequestInit['redirect'] }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get('authorization'), redirect: init?.redirect });
    const route = routes[url];
    return route === undefined ? new Response('missing', { status: 404 }) : route();
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });

describe('issue attachment links', () => {
  it('finds images and file links in order, once per image wrapped in a link, without emojis or proxied images', () => {
    const html = [
      `<p>Mockup<br><a target="_blank" href="${SIGNED}"><img width="2000" alt="Desktop &amp; mobile" src="${SIGNED}" class="x"></a></p>`,
      '<img class="emoji" alt=":+1:" src="https://github.githubassets.com/images/icons/emoji/unicode/1f44d.png">',
      '<img src="https://camo.githubusercontent.com/abc/def" alt="badge">',
      '<a href="https://github.com/user-attachments/files/123/spec.pdf">spec.pdf</a>',
      '<a href="https://github.com/acme/app/pull/3">#3</a>',
      '<img src="https://github.com/user-attachments/assets/1ee81745-ed59" alt="">',
    ].join('\n');
    assert.deepEqual(extractAttachmentLinks(html, 'description', ORIGIN), [
      { url: SIGNED.replace('&amp;', '&'), label: 'Desktop & mobile', source: 'description' },
      { url: 'https://github.com/user-attachments/files/123/spec.pdf', label: 'spec.pdf', source: 'description' },
      { url: 'https://github.com/user-attachments/assets/1ee81745-ed59', label: '', source: 'description' },
    ]);
  });

  it('accepts only uploads on the web origin or on GitHub image hosts, over https', () => {
    assert.equal(isUploadUrl('https://github.com/user-attachments/assets/x', ORIGIN), true);
    assert.equal(isUploadUrl('https://github.com/acme/app/assets/1/x', ORIGIN), true);
    assert.equal(isUploadUrl('https://user-images.githubusercontent.com/1/x.png', ORIGIN), true);
    assert.equal(isUploadUrl('https://github.com/acme/app/issues/1', ORIGIN), false);
    assert.equal(isUploadUrl('https://evil.example/user-attachments/assets/x', ORIGIN), false);
    assert.equal(isUploadUrl('http://private-user-images.githubusercontent.com/x.png', ORIGIN), false);
    assert.equal(isUploadUrl('not a url', ORIGIN), false);
  });

  it('derives the web origin from the GraphQL endpoint, also for GitHub Enterprise', () => {
    assert.equal(webOrigin('https://api.github.com/graphql'), 'https://github.com');
    assert.equal(webOrigin('https://ghe.example.com/api/graphql'), 'https://ghe.example.com');
  });

  it('takes the extension from the content type, else from the file name', () => {
    assert.equal(attachmentExtension('image/jpeg; charset=binary', 'https://x.test/a'), 'jpg');
    assert.equal(attachmentExtension('application/pdf', 'https://x.test/a'), 'pdf');
    assert.equal(attachmentExtension('application/octet-stream', 'https://x.test/files/1/Log.TXT'), 'txt');
    assert.equal(attachmentExtension(null, 'https://x.test/files/1/blob'), 'bin');
  });
});

describe('issue attachment download', () => {
  const link = { url: 'https://github.com/user-attachments/assets/abc', label: 'Mockup', source: 'description' };

  it('sends the token only to the web origin and follows the redirect to the signed URL without it', async () => {
    const signed = 'https://objects.githubusercontent.com/abc?sig=1';
    const { fetchImpl, requests } = fakeFetch({
      [link.url]: () => new Response(null, { status: 302, headers: { location: signed } }),
      [signed]: png,
    });
    const result = await downloadAttachment(link, { fetch: fetchImpl, token: 'tok', origin: ORIGIN, timeoutMs: 1000 });
    assert.equal(result.error, null);
    assert.equal(result.extension, 'png');
    assert.deepEqual([...(result.data ?? [])], [137, 80, 78, 71]);
    assert.deepEqual(
      requests.map((request) => [request.url, request.authorization, request.redirect]),
      [
        [link.url, 'token tok', 'manual'],
        [signed, null, 'manual'],
      ],
    );
  });

  it('reports HTTP errors, oversized files and redirect loops instead of throwing', async () => {
    const options = (routes: Record<string, () => Response>) => ({ fetch: fakeFetch(routes).fetchImpl, token: 'tok', origin: ORIGIN, timeoutMs: 1000 });
    assert.equal((await downloadAttachment(link, options({}))).error, 'HTTP 404');
    const huge = () => new Response('x', { headers: { 'content-length': String(MAX_ATTACHMENT_BYTES + 1) } });
    assert.match((await downloadAttachment(link, options({ [link.url]: huge }))).error ?? '', /larger than 20 MB/);
    const loop = () => new Response(null, { status: 302, headers: { location: link.url } });
    assert.match((await downloadAttachment(link, options({ [link.url]: loop }))).error ?? '', /more than 5 redirects/);
    const insecure = () => new Response(null, { status: 302, headers: { location: 'http://objects.example/x' } });
    assert.match((await downloadAttachment(link, options({ [link.url]: insecure }))).error ?? '', /non-https/);
  });
});

describe('github_project issueAttachments', () => {
  it('reads the description and every comment page and downloads the uploads in order', async () => {
    const comment = 'https://github.com/acme/app/issues/7#issuecomment-1';
    const fileUrl = 'https://github.com/user-attachments/files/9/notes.txt';
    let page = 0;
    const { fetchImpl, requests } = fakeFetch({
      'https://api.github.com/graphql': () => {
        page++;
        const node =
          page === 1
            ? {
                bodyHTML: `<p><img alt="Dashboard" src="${SIGNED}"></p>`,
                comments: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ url: comment, bodyHTML: '<p>no files</p>' }] },
              }
            : {
                bodyHTML: '<p>ignored on later pages</p>',
                comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ url: comment, bodyHTML: `<a href="${fileUrl}">notes.txt</a>` }] },
              };
        return Response.json({ data: { node } });
      },
      [SIGNED.replace('&amp;', '&')]: png,
      [fileUrl]: () => new Response('hello', { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    });
    const adapter = githubProjectFactory.create({
      provider: { owner: 'acme', project_number: 1, token: 'tok', request_retries: 0 },
      activeStates: ['Todo'],
      terminalStates: ['Done'],
      env: {},
      logger: Logger.silent(),
      fetch: fetchImpl,
    });
    const issue = makeIssue({
      id: 'PVTI_7',
      identifier: 'acme/app#7',
      native_ref: { provider: 'github_project', item_id: 'PVTI_7', issue_id: 'I_7', repository: 'acme/app', number: 7 },
    });
    const attachments = await adapter.issueAttachments?.(issue);
    assert.deepEqual(
      attachments?.map(({ label, source, extension, error }) => ({ label, source, extension, error })),
      [
        { label: 'Dashboard', source: 'description', extension: 'png', error: null },
        { label: 'notes.txt', source: comment, extension: 'txt', error: null },
      ],
    );
    // The signed image URL goes out without the token; the file link on github.com carries it.
    const downloads = requests.filter((request) => request.url !== 'https://api.github.com/graphql');
    assert.deepEqual(
      downloads.map((request) => request.authorization),
      [null, 'token tok'],
    );
  });
});

describe('writeAttachments', () => {
  const attachment = (overrides: Partial<IssueAttachment>): IssueAttachment => ({
    label: 'Mockup',
    source: 'description',
    extension: 'png',
    data: new Uint8Array([1, 2, 3]),
    error: null,
    ...overrides,
  });

  it('writes the files and an index, keeps them out of git and replaces an earlier set', async () => {
    const workspace = tempDir();
    execFileSync('git', ['init', '--quiet'], { cwd: workspace });
    fs.mkdirSync(path.join(workspace, ATTACHMENTS_DIR));
    fs.writeFileSync(path.join(workspace, ATTACHMENTS_DIR, 'attachment-9.png'), 'stale');

    const files = await writeAttachments(workspace, [
      attachment({}),
      attachment({ label: '', source: 'https://github.com/acme/app/issues/7#issuecomment-1', extension: '', data: null, error: 'HTTP 404' }),
      attachment({ label: 'Spec', extension: 'pdf' }),
    ]);
    assert.deepEqual(files, [
      { path: '.issue-assets/attachment-1.png', label: 'Mockup', source: 'description', error: null },
      { path: null, label: '', source: 'https://github.com/acme/app/issues/7#issuecomment-1', error: 'HTTP 404' },
      { path: '.issue-assets/attachment-3.pdf', label: 'Spec', source: 'description', error: null },
    ]);
    assert.deepEqual(fs.readdirSync(path.join(workspace, ATTACHMENTS_DIR)).sort(), ['INDEX.md', 'attachment-1.png', 'attachment-3.pdf']);
    const index = fs.readFileSync(path.join(workspace, ATTACHMENTS_DIR, 'INDEX.md'), 'utf8');
    assert.match(index, /attachment-1\.png: Mockup \(description\)/);
    assert.match(index, /attachment 2: not downloaded \(HTTP 404\): no label/);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' }), '');

    // A second run does not add the exclude entry twice; an issue without attachments leaves no directory.
    await writeAttachments(workspace, [attachment({})]);
    const exclude = fs.readFileSync(path.join(workspace, '.git', 'info', 'exclude'), 'utf8');
    assert.equal(exclude.split('\n').filter((line) => line === '/.issue-assets/').length, 1);
    assert.deepEqual(await writeAttachments(workspace, []), []);
    assert.equal(fs.existsSync(path.join(workspace, ATTACHMENTS_DIR)), false);
  });
});

describe('attachments in the shipped prompt', () => {
  const shipped = path.join(import.meta.dirname, '..', 'WORKFLOW.md');
  const issue = makeIssue({
    id: 'PVTI_1',
    identifier: 'acme/app#42',
    title: 'Dashboard',
    description: 'Hier eine Vorschau',
    state: 'Ready',
    native_ref: { provider: 'github_project', repository: 'acme/app', number: 42, parent: null, sub_issues: [], base_branch: null },
  });
  const render = async (role: string, attachments?: unknown[]) => {
    const { definition } = await loadWorkflowFile(shipped);
    return renderPrompt(compilePrompt(definition.promptTemplate, definition.partials), {
      issue: issueTemplateValue(issue),
      attempt: null,
      role,
      ...(attachments !== undefined ? { attachments } : {}),
    });
  };
  const files = [
    { path: '.issue-assets/attachment-1.png', label: 'Image', source: 'description', error: null },
    { path: null, label: '', source: 'https://github.com/acme/app/issues/42#issuecomment-1', error: 'HTTP 404' },
  ];

  it('lists the files, tells the agent to open them and asks the analyst to describe them', async () => {
    const prompt = await render('issue-analyst', files);
    assert.match(prompt, /## Attachments/);
    assert.match(prompt, /open every file below with the Read tool/);
    assert.match(prompt, /- `\.issue-assets\/attachment-1\.png`: "Image", from the description/);
    assert.match(prompt, /- not downloaded \(HTTP 404\), from https:\/\/github\.com\/acme\/app\/issues\/42#issuecomment-1/);
    assert.match(prompt, /describe what each attachment shows/);
  });

  it('has no attachments section without attachments', async () => {
    for (const prompt of [await render('issue-analyst'), await render('developer', [])]) {
      assert.doesNotMatch(prompt, /## Attachments|describe what each attachment shows|Name the attachments/);
    }
  });

  it('asks the developer to name the attachments it implements', async () => {
    assert.match(await render('developer', files), /Name the attachments \(mockups, screenshots\) the change implements/);
  });
});
