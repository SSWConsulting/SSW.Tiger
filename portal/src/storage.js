import { createHash, randomBytes } from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { UserStore } from './users.js';
import { meetingStats, projectsFromBlobs } from './projects.js';

export function createStorage(config) {
  const credential = process.env.AZURE_CLIENT_ID
    ? new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID })
    : new DefaultAzureCredential();
  const service = new BlobServiceClient(`https://${config.account}.blob.core.windows.net`, credential);
  const database = new CosmosClient({ endpoint: config.cosmosEndpoint, aadCredentials: credential }).database(config.cosmosDatabase);
  return {
    meetings: database.container(config.meetingContainer),
    reports: service.getContainerClient(config.container),
    sessions: new SessionStore(service.getContainerClient(config.sessionContainer)),
    users: new UserStore(database.container(config.userContainer), config.issuer),
  };
}

async function readJson(response) {
  const chunks = [];
  for await (const chunk of response.readableStreamBody) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
      const data = await readJson(response);
      if (consume || data.expiresAt <= this.now()) await blob.delete({ conditions: { ifMatch: response.etag } });
      return data.expiresAt > this.now() ? data : null;
    } catch (error) {
      if ([404, 412].includes(error.statusCode)) return null;
      throw error;
    }
  }
  // Use conditional writes to prevent concurrent refreshes from overwriting new tokens or recreating sessions after logout.
  async update(id, transform) {
    const blob = this.blob(id, 'session');
    if (!blob) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await blob.download();
        const current = await readJson(response);
        if (current.expiresAt <= this.now()) return null;
        const next = await transform(current);
        if (current.expiresAt <= this.now()) return null;
        if (next === current) return current;
        const body = JSON.stringify({ ...next, expiresAt: current.expiresAt });
        await blob.upload(body, Buffer.byteLength(body), {
          conditions: { ifMatch: response.etag },
          blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' },
        });
        return { ...next, expiresAt: current.expiresAt };
      } catch (error) {
        if (error.statusCode === 404) return null;
        if (error.statusCode !== 412) throw error;
      }
    }
    throw new Error('Session changed concurrently');
  }
  async remove(id, kind) { await this.blob(id, kind)?.deleteIfExists(); }
}

// One flat listing covers every project index and meeting report without reading report bodies.
export async function listProjects(container, project, meetings) {
  const blobs = [];
  for await (const blob of container.listBlobsFlat({ includeMetadata: true, ...(project ? { prefix: `${project}/` } : {}) })) blobs.push(blob);
  const projects = projectsFromBlobs(blobs);
  if (!meetings || !projects.length) return projects;
  // Query card summaries only; published blobs remain the source of truth for the report list.
  const { resources } = await meetings.items.query({
    query: 'SELECT c.projectName, c.meetingId, c.metadata FROM c WHERE c.type = @type' + (project ? ' AND c.projectName = @project' : ''),
    parameters: [{ name: '@type', value: 'meeting' }, ...(project ? [{ name: '@project', value: project }] : [])],
  }).fetchAll();
  const summaries = new Map(resources.map(item => [JSON.stringify([item.projectName, item.meetingId]), item.metadata]));
  for (const item of projects) for (const meeting of item.meetings) {
    meeting.stats = meetingStats(summaries.get(JSON.stringify([item.project, meeting.id])));
  }
  return projects;
}
