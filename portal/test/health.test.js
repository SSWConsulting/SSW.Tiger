import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/app.js';
import { serve } from './helpers.js';

test('health returns the running release revision without authentication or storage access', async t => {
  const revision = 'a'.repeat(40);
  const get = await serve(t, createHandler({ revision }));
  const response = await get('/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', revision });
  assert.match(response.headers.get('cache-control'), /no-store/);
  const head = await get('/healthz', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
