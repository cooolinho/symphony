import { errorMessage } from '../../util/errors.ts';
import type { IssueAttachment } from '../types.ts';

/** Files per issue; the rest is listed with an error. */
export const MAX_ATTACHMENTS = 20;
/** Largest file downloaded; a larger one is listed with an error. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** An uploaded file referenced in the rendered HTML of an issue or comment. */
export interface AttachmentLink {
  url: string;
  label: string;
  source: string;
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/zip': 'zip',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match === null ? null : decodeEntities(match[1] ?? '');
}

/** The browser origin of GitHub (or GitHub Enterprise) for a GraphQL endpoint: the only origin that gets the token. */
export function webOrigin(endpoint: string): string {
  const url = new URL(endpoint);
  return url.hostname === 'api.github.com' ? 'https://github.com' : url.origin;
}

/**
 * Whether a URL is a file uploaded to GitHub: `user-attachments` (and the older `<owner>/<repo>/assets`) on the web
 * origin, or GitHub's own image hosts. Emojis, icons and images proxied from other sites (camo) are no attachments.
 */
export function isUploadUrl(url: string, origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.origin === origin) return /^\/(user-attachments\/(assets|files)\/|[^/]+\/[^/]+\/assets\/)/.test(parsed.pathname);
  return parsed.hostname === 'private-user-images.githubusercontent.com' || parsed.hostname === 'user-images.githubusercontent.com';
}

/**
 * The uploaded files in rendered issue HTML, in order of appearance: images (`<img>`, labelled by their alt text) and
 * file links (`<a href=".../user-attachments/files/...">`, labelled by their text). An image wrapped in a link to itself
 * counts once.
 */
export function extractAttachmentLinks(html: string, source: string, origin: string): AttachmentLink[] {
  const links: AttachmentLink[] = [];
  for (const match of html.matchAll(/<img\b[^>]*>|<a\b[^>]*>([^<]*)<\/a>/g)) {
    const tag = match[0];
    const isImage = tag.startsWith('<img');
    const url = attribute(tag, isImage ? 'src' : 'href');
    if (url === null || !isUploadUrl(url, origin)) continue;
    if (!isImage && !new URL(url).pathname.startsWith('/user-attachments/files/')) continue;
    const label = isImage ? (attribute(tag, 'alt') ?? '') : decodeEntities(match[1] ?? '');
    links.push({ url, label: label.trim(), source });
  }
  return links;
}

/** File extension for a download: from its content type, else from the URL's file name, else `bin`. */
export function attachmentExtension(contentType: string | null, url: string): string {
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const known = EXTENSIONS[type];
  if (known !== undefined) return known;
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(new URL(url).pathname)?.[1];
  return fromName?.toLowerCase() ?? 'bin';
}

export interface DownloadOptions {
  fetch: typeof fetch;
  token: string;
  /** See `webOrigin`; only requests to it carry the token. */
  origin: string;
  timeoutMs: number;
}

/**
 * Downloads one uploaded file. Redirects are followed by hand so the token only goes to the web origin: GitHub answers
 * there with a redirect to a signed URL that needs no credentials. Private images come as such signed URLs already
 * (valid for a few minutes), so call this right after reading the HTML.
 */
export async function downloadAttachment(link: AttachmentLink, options: DownloadOptions): Promise<IssueAttachment> {
  const failed = (error: string): IssueAttachment => ({ label: link.label, source: link.source, extension: '', data: null, error });
  try {
    let url = link.url;
    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = { 'user-agent': 'symphony-orchestrator/0.1' };
      if (new URL(url).origin === options.origin) headers.authorization = `token ${options.token}`;
      const response = await options.fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs) });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await response.body?.cancel();
        if (hop >= MAX_REDIRECTS) return failed(`more than ${MAX_REDIRECTS} redirects`);
        url = new URL(location, url).toString();
        if (!url.startsWith('https://')) return failed('redirect to a non-https URL');
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return failed(`HTTP ${response.status}`);
      }
      const announced = Number(response.headers.get('content-length') ?? 0);
      if (announced > MAX_ATTACHMENT_BYTES) {
        await response.body?.cancel();
        return failed(`larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
      }
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength > MAX_ATTACHMENT_BYTES) return failed(`larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
      return { label: link.label, source: link.source, extension: attachmentExtension(response.headers.get('content-type'), url), data, error: null };
    }
  } catch (error) {
    return failed(errorMessage(error));
  }
}

/** Downloads the links one after another; beyond `MAX_ATTACHMENTS` they are listed with an error, not downloaded. */
export async function downloadAttachments(links: AttachmentLink[], options: DownloadOptions): Promise<IssueAttachment[]> {
  const seen = new Set<string>();
  const unique = links.filter((link) => !seen.has(link.url) && seen.add(link.url));
  const attachments: IssueAttachment[] = [];
  for (const [index, link] of unique.entries()) {
    attachments.push(
      index < MAX_ATTACHMENTS
        ? await downloadAttachment(link, options)
        : { label: link.label, source: link.source, extension: '', data: null, error: `more than ${MAX_ATTACHMENTS} attachments` },
    );
  }
  return attachments;
}
