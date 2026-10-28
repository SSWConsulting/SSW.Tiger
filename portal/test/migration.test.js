import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateReports } from '../src/reportMigration.js';

function container(initial = {}) {
  let version = 0;
  const data = new Map();
  const deleted = [];
  const set = (name, body) => data.set(name, { bytes: Buffer.from(body), etag: `etag-${++version}`, lastModified: new Date(1700000000000 + version * 1000), metadata: { displayname: 'CRM' }, contentType: 'text/html' });
  for (const [name, body] of Object.entries(initial)) set(name, body);
  const error = statusCode => Object.assign(new Error('storage'), { statusCode });
  return {
    data, deleted, set,
    async getProperties() { return {}; },
    async getAccessPolicy() { throw new Error('ACL permissions must not be required'); },
    async *listBlobsFlat() { for (const [name, entry] of data) yield { name, properties: entry, metadata: entry.metadata }; },
    getBlockBlobClient(name) {
      return {
        async getProperties() { if (!data.has(name)) throw error(404); return data.get(name); },
        async downloadToBuffer(offset, length, options) {
          const entry = data.get(name);
          if (!entry) throw error(404);
          if (entry.etag !== options.conditions.ifMatch) throw error(412);
          return entry.bytes;
        },
        async upload(bytes, length, options) {
          if (data.has(name)) throw error(412);
          assert.equal(options.conditions.ifNoneMatch, '*');
          assert.equal(typeof options.metadata, 'object');
          set(name, bytes);
        },
        async delete(options) {
          if (data.get(name)?.etag !== options.conditions.ifMatch) throw error(412);
          deleted.push(name); data.delete(name);
        },
      };
    },
  };
}

function fixture() {
  const source = container({ 'index.html': 'old root', 'crm/index.html': 'old project', 'crm/meeting/index.html': 'encrypted password page' });
  const target = container();
  let saved;
  const options = { source, target, manifest: { entries: {} }, apply: true, saveManifest: async value => { saved = structuredClone(value); } };
  return { source, target, options, saved: () => saved };
}

test('migration uses ordinary container read permission and persists evidence without deleting sources', async () => {
  const f = fixture();
  assert.equal((await migrateReports(f.options)).blobCount, 3);
  assert.equal(f.source.deleted.length, 0);
  assert.equal(f.saved().entries['crm/meeting/index.html'].sourceEtag, f.source.data.get('crm/meeting/index.html').etag);
  assert.equal(f.target.data.get('crm/meeting/index.html').bytes.toString(), 'encrypted password page');
  assert.equal((await migrateReports(f.options)).blobCount, 3);
});

test('historical reports with empty metadata can be copied without deleting their source', async () => {
  for (const metadata of ['', null, undefined]) {
    const f = fixture();
    for (const entry of f.source.data.values()) entry.metadata = metadata;
    assert.equal((await migrateReports(f.options)).mode, 'copied-verified');
    assert.equal(f.target.data.size, 3);
    assert.equal(f.source.data.size, 3);
  }
});

test('cleanup permits newer private root and project indexes using the original manifest', async () => {
  const f = fixture(); await migrateReports(f.options);
  f.target.set('index.html', 'new root'); f.target.set('crm/index.html', 'new project');
  await migrateReports({ ...f.options, manifest: f.saved(), remove: true });
  assert.equal(f.source.data.size, 0);
  assert.equal(f.target.data.get('index.html').bytes.toString(), 'new root');
  assert.equal(f.target.data.get('crm/index.html').bytes.toString(), 'new project');
});

test('different password report or changed source blocks cleanup before any deletion', async () => {
  for (const changedSource of [false, true]) {
    const f = fixture(); await migrateReports(f.options);
    if (changedSource) f.source.set('crm/meeting/index.html', 'changed public report');
    else f.target.set('crm/meeting/index.html', 'rotated private password page');
    await assert.rejects(migrateReports({ ...f.options, remove: true }), changedSource ? /Source changed/ : /Different destination/);
    assert.deepEqual(f.source.deleted, []);
  }
});

test('cleanup cannot accept missing manifest evidence or an unverified differing index', async () => {
  const f = fixture();
  await assert.rejects(migrateReports({ ...f.options, remove: true }), /Missing migration record/);
  f.target.set('index.html', 'different pre-existing index');
  await assert.rejects(migrateReports(f.options), /Different destination/);
  assert.deepEqual(f.source.deleted, []);
});

test('dry-run writes nothing and a public destination is rejected', async () => {
  const f = fixture();
  assert.equal((await migrateReports({ ...f.options, apply: false })).mode, 'dry-run');
  assert.equal(f.target.data.size, 0);
  f.target.getProperties = async () => ({ blobPublicAccess: 'blob' });
  await assert.rejects(migrateReports(f.options), /must be private/);
});


test('failed manifest persistence cannot delete sources, and cleanup requires apply mode', async () => {
  const f = fixture();
  await assert.rejects(migrateReports({ ...f.options, saveManifest: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.deepEqual(f.source.deleted, []);
  await assert.rejects(migrateReports({ ...f.options, apply: false, remove: true }), /requires apply/);
});
