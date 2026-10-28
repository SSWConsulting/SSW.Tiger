import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from '../scripts/build.mjs';

test('build restores a persistent compiler cache and saves it only after success', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'portal-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = join(directory, 'persistent');
  const local = join(directory, '.next/cache');
  const log = () => {};
  await build({ directory, cache, log, run: async () => {
    await mkdir(local, { recursive: true });
    await writeFile(join(local, 'compiler'), 'first build');
    await writeFile(join(local, 'obsolete'), 'old compiler cache');
  } });
  await rm(join(directory, '.next'), { recursive: true });
  await build({ directory, cache, log, run: async () => {
    assert.equal(await readFile(join(local, 'compiler'), 'utf8'), 'first build');
    await rm(join(local, 'obsolete'));
    await writeFile(join(local, 'compiler'), 'second build');
  } });
  assert.equal(await readFile(join(cache, 'compiler'), 'utf8'), 'second build');
  await assert.rejects(readFile(join(cache, 'obsolete')), { code: 'ENOENT' });
  await assert.rejects(() => build({ directory, cache, log, run: async () => {
    await writeFile(join(local, 'compiler'), 'failed build');
    throw new Error('compile failed');
  } }), /compile failed/);
  assert.equal(await readFile(join(cache, 'compiler'), 'utf8'), 'second build');
});

test('build continues when the optional persistent cache cannot be read', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'portal-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = join(directory, 'not-a-directory');
  await writeFile(cache, 'unavailable');
  let ran = false;
  await build({ directory, cache, log: () => {}, run: async () => { ran = true; } });
  assert.equal(ran, true);
});
