import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { README_TEXT, ensureVault } from '../src/brain/vault.ts';
import { tempDir } from './helpers.ts';

const REVIEW = 'Kandidaten-Review.base';
const LESSONS = 'Neueste Lessons.base';

type BaseView = { type: string; name?: string; order: string[]; sort: { property: string; direction: string }[]; limit?: number };
type Base = { filters: { and: string[] }; views: BaseView[] };

async function vaultWithBases(): Promise<{ vault: string; review: Base; lessons: Base }> {
  const vault = path.join(tempDir(), 'vault');
  await ensureVault(vault, []);
  return {
    vault,
    review: parse(fs.readFileSync(path.join(vault, REVIEW), 'utf8')) as Base,
    lessons: parse(fs.readFileSync(path.join(vault, LESSONS), 'utf8')) as Base,
  };
}

describe('Bases views of the vault', () => {
  it('creates both files in the vault root as non-empty files', async () => {
    const { vault } = await vaultWithBases();
    for (const name of [REVIEW, LESSONS]) {
      const stat = fs.statSync(path.join(vault, name));
      assert.ok(stat.isFile(), name);
      assert.ok(stat.size > 0, name);
    }
  });

  it('reports the new files in the result of the first call and nothing on the second', async () => {
    const vault = path.join(tempDir(), 'vault');
    const first = await ensureVault(vault, []);
    assert.ok(first.includes(REVIEW));
    assert.ok(first.includes(LESSONS));
    assert.deepEqual(await ensureVault(vault, []), []);
  });

  it('Kandidaten-Review: status filter, columns and ascending sort by created', async () => {
    const { review } = await vaultWithBases();
    assert.deepEqual(review.filters.and, ['status == "candidate"']);
    assert.equal(review.views.length, 1);
    const [view] = review.views;
    assert.equal(view?.type, 'table');
    assert.deepEqual(view?.order, ['file.name', 'type', 'repo', 'issue', 'role', 'created']);
    assert.deepEqual(view?.sort, [{ property: 'created', direction: 'ASC' }]);
    assert.equal(view?.limit, undefined);
  });

  it('Neueste Lessons: type filter, columns, descending sort by updated and limit 50', async () => {
    const { lessons } = await vaultWithBases();
    assert.deepEqual(lessons.filters.and, ['type == "lesson"']);
    assert.equal(lessons.views.length, 1);
    const [view] = lessons.views;
    assert.equal(view?.type, 'table');
    assert.deepEqual(view?.order, ['file.name', 'status', 'repo', 'updated']);
    assert.deepEqual(view?.sort, [{ property: 'updated', direction: 'DESC' }]);
    assert.strictEqual(view?.limit, 50);
  });

  it('keeps a changed file of either kind untouched (content and mtime)', async () => {
    const vault = path.join(tempDir(), 'vault');
    fs.mkdirSync(vault);
    const review = path.join(vault, REVIEW);
    const lessons = path.join(vault, LESSONS);
    fs.writeFileSync(review, 'filters: mine\n');
    fs.writeFileSync(lessons, '');
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(review, past, past);
    fs.utimesSync(lessons, past, past);
    const created = await ensureVault(vault, []);
    assert.equal(fs.readFileSync(review, 'utf8'), 'filters: mine\n');
    assert.equal(fs.readFileSync(lessons, 'utf8'), '');
    assert.equal(fs.statSync(review).mtimeMs, past.getTime());
    assert.equal(fs.statSync(lessons).mtimeMs, past.getTime());
    assert.ok(!created.includes(REVIEW));
    assert.ok(!created.includes(LESSONS));
  });

  it('recreates only a missing file after the other was edited', async () => {
    const vault = path.join(tempDir(), 'vault');
    await ensureVault(vault, []);
    fs.writeFileSync(path.join(vault, LESSONS), 'edited');
    fs.rmSync(path.join(vault, REVIEW));
    const created = await ensureVault(vault, []);
    assert.deepEqual(created, [REVIEW]);
    assert.equal(fs.readFileSync(path.join(vault, LESSONS), 'utf8'), 'edited');
    assert.deepEqual((parse(fs.readFileSync(path.join(vault, REVIEW), 'utf8')) as Base).filters.and, ['status == "candidate"']);
  });

  it('leaves a directory with the file name alone', async () => {
    const vault = path.join(tempDir(), 'vault');
    fs.mkdirSync(path.join(vault, REVIEW), { recursive: true });
    const created = await ensureVault(vault, []);
    assert.ok(!created.includes(REVIEW));
    assert.ok(fs.statSync(path.join(vault, REVIEW)).isDirectory());
  });

  it('README mentions both views in the written text', async () => {
    const { vault } = await vaultWithBases();
    const readme = fs.readFileSync(path.join(vault, 'README.md'), 'utf8');
    assert.equal(readme, README_TEXT);
    const sentence = readme.split(/(?<=\.)\s+/).find((s) => s.includes(REVIEW));
    assert.ok(sentence, 'sentence with Kandidaten-Review.base');
    assert.ok(sentence.includes(LESSONS), 'same sentence names Neueste Lessons.base');
    assert.match(sentence, /Bases/);
  });
});
