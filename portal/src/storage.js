import { createHash, randomBytes } from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

export function createStorage(config) {
  const credential = process.env.AZURE_CLIENT_ID
    ? new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID })
    : new DefaultAzureCredential();
  const service = new BlobServiceClient(`https://${config.account}.blob.core.windows.net`, credential);
  return {
    reports: service.getContainerClient(config.container),
    sessions: new SessionStore(service.getContainerClient(config.sessionContainer)),
  };
}

// Store sessions in private Blob storage for multiple instances and logout revocation.
export class SessionStore {
  constructor(container, now = () => Date.now()) { this.container = container; this.now = now; }
  blob(id, kind) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id || '')) return null;
    const hash = createHash('sha256').update(id).digest('hex');
    return this.container.getBlockBlobClient(`${kind}/${hash}.json`);
  }
  async create(kind, data, ttlSeconds) {
    const id = randomBytes(32).toString('base64url');
    const body = JSON.stringify({ ...data, expiresAt: this.now() + ttlSeconds * 1000 });
    await this.blob(id, kind).upload(body, Buffer.byteLength(body), {
      conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' },
    });
    return id;
  }
  async read(id, kind, consume = false) {
    const blob = this.blob(id, kind);
    if (!blob) return null;
    try {
      const response = await blob.download();
      const chunks = [];
      for await (const chunk of response.readableStreamBody) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (consume || data.expiresAt <= this.now()) await blob.delete({ conditions: { ifMatch: response.etag } });
      return data.expiresAt > this.now() ? data : null;
    } catch (error) {
      if ([404, 412].includes(error.statusCode)) return null;
      throw error;
    }
  }
  async remove(id, kind) { await this.blob(id, kind)?.deleteIfExists(); }
}

export async function listProjects(container) {
  const result = [];
  // List project indexes hierarchically without scanning meeting report bodies.
  for await (const item of container.listBlobsByHierarchy('/')) {
    if (item.kind !== 'prefix') continue;
    const project = item.name.slice(0, -1);
    try {
      const props = await container.getBlockBlobClient(`${project}/index.html`).getProperties();
      let displayName = project;
      try { displayName = decodeURIComponent(props.metadata?.displayname || project); } catch { /* Keep the project path as the fallback name. */ }
      result.push({ project, displayName, updatedAt: props.lastModified?.toISOString() || '' });
    } catch (error) { if (error.statusCode !== 404) throw error; }
  }
  return result.sort((a, b) => a.displayName.localeCompare(b.displayName));
}
