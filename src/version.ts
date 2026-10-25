import fs from 'node:fs';

/** Symphony's release version: `version` of package.json (a release tag `v<version>` names the same). */
export const SYMPHONY_VERSION: string = (() => {
  try {
    const version = (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' && version !== '' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
})();
