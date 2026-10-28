import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';

export function memoryContainer() {
  const blobs = new Map(); let version = 0;
  const container = { blobs, uploads: 0, beforeUpload: null, getBlockBlobClient(name) {
    return {
      name,
      async upload(body, size, options = {}) {
        if (container.beforeUpload) { const action = container.beforeUpload; container.beforeUpload = null; action(name); }
        const previous = blobs.get(name);
        const condition = options.conditions || {};
        if ((condition.ifNoneMatch === '*' && previous) || (condition.ifMatch && condition.ifMatch !== previous?.etag)) {
          throw Object.assign(new Error('changed'), { statusCode: 412 });
        }
        container.uploads++;
        blobs.set(name, { body: Buffer.from(body), etag: String(++version) });
      },
      async download() {
        const entry = blobs.get(name);
        if (!entry) throw Object.assign(new Error('missing'), { statusCode: 404 });
        return { readableStreamBody: Readable.from([entry.body]), etag: entry.etag };
      },
      async delete(options) {
        const entry = blobs.get(name);
        if (!entry) throw Object.assign(new Error('missing'), { statusCode: 404 });
        if (entry.etag !== options.conditions.ifMatch) throw Object.assign(new Error('changed'), { statusCode: 412 });
        blobs.delete(name);
      },
      async deleteIfExists() { blobs.delete(name); },
    };
  } };
  return container;
}

export async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (path, options = {}) => new Promise((resolve, reject) => {
    const call = httpRequest(`${origin}${path}`, { method: options.method || 'GET', headers: { Host: 'portal.test', ...options.headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(key, item);
        }
        resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    call.on('error', reject); call.end(options.body);
  });
}

export function signedIssuer(config) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  return {
    async sign(overrides = {}, key = privateKey) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ iss: config.issuer, aud: config.apiAudience, client_id: config.clientId, sub: 'employee-1', name: 'SSW User', email: 'staff@ssw.com.au', email_verified: true, scope: config.apiScope, iat: now, exp: now + 300, ...overrides })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'at+jwt' }).sign(key);
    },
    async fetch(url) {
      if (String(url) === `${config.issuer}/.well-known/openid-configuration`) return json({ issuer: config.issuer, jwks_uri: `${config.issuer}/jwks` });
      if (String(url) === `${config.issuer}/jwks`) return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] });
      throw new Error('Unexpected issuer request');
    },
  };
}

export function memoryUsers() {
  const documents = new Map(); let version = 0;
  const container = { documents, writes: 0, beforeWrite: null };
  const fail = code => Object.assign(new Error(`Cosmos ${code}`), { code });
  const write = (value, condition, create) => {
    if (container.beforeWrite) { const action = container.beforeWrite; container.beforeWrite = null; action(value.id); }
    const previous = documents.get(value.id);
    if (create && previous) throw fail(409);
    if (!create && (!previous || condition !== previous._etag)) throw fail(412);
    const next = { ...structuredClone(value), _etag: String(++version) };
    documents.set(value.id, next); container.writes++;
    return { resource: structuredClone(next) };
  };
  container.item = (id, partition) => {
    if (partition !== id) throw new Error('Unexpected partition');
    return {
      async read() { return { resource: structuredClone(documents.get(id)) }; },
      async replace(value, options) { return write(value, options.accessCondition.condition, false); },
    };
  };
  container.items = {
    async create(value) { return write(value, undefined, true); },
    query({ parameters }) {
      const values = Object.fromEntries(parameters.map(({ name, value }) => [name, value]));
      return { async fetchAll() { return { resources: structuredClone([...documents.values()].filter(value =>
        value.type === values['@type'] && value.issuer === values['@issuer'] && value.email?.toLowerCase() === values['@email'])) }; } };
    },
  };
  return container;
}
