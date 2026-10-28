const { BlobServiceClient } = require('@azure/storage-blob');
const { AzureCliCredential } = require('@azure/identity');
const { createHash } = require('node:crypto');
const { ensureDashboardInitialClasses } = require('../lib/dashboardPresentation');

// Repair staging only; default to preview mode and never print or export meeting content.
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/repair-dashboard-initial-classes.js [--apply]');
  const apply = args.includes('--apply');
  const service = new BlobServiceClient('https://satigertestweb.blob.core.windows.net', new AzureCliCredential());
  const container = service.getContainerClient('reports');
  const results = [];
  for await (const item of container.listBlobsFlat()) {
    if (!/^[^/]+\/[^/]+\/index\.html$/.test(item.name)) continue;
    const blob = container.getBlockBlobClient(item.name);
    const before = await blob.getProperties();
    const bytes = await blob.downloadToBuffer(0, undefined, { conditions: { ifMatch: before.etag } });
    const original = bytes.toString('utf8');
    const repaired = ensureDashboardInitialClasses(original);
    if (repaired === original) continue;
    // Only add known static classes to preserve content and dynamic interactions.
    const restored = repaired.replace(/<(div|button) class="(?:ds-shell|ds-navitem|ds-topnav-item)"/g, '<$1');
    const comparable = original.replace(/<(div|button) class="(?:ds-shell|ds-navitem|ds-topnav-item)"/g, '<$1');
    if (restored !== comparable) throw new Error(`Unexpected content change: ${item.name}`);
    const result = { name: item.name, changed: true };
    if (apply) {
      const { tags } = await blob.getTags();
      const snapshot = await blob.createSnapshot({ conditions: { ifMatch: before.etag } });
      const updated = Buffer.from(repaired);
      const uploaded = await blob.uploadData(updated, {
        conditions: { ifMatch: before.etag }, metadata: before.metadata, tags,
        blobHTTPHeaders: {
          blobContentType: before.contentType, blobCacheControl: before.cacheControl,
          blobContentDisposition: before.contentDisposition, blobContentEncoding: before.contentEncoding,
          blobContentLanguage: before.contentLanguage,
          blobContentMD5: createHash('md5').update(updated).digest(),
        },
      });
      const readBack = await blob.downloadToBuffer(0, undefined, { conditions: { ifMatch: uploaded.etag } });
      if (!readBack.equals(updated)) throw new Error(`Read-back mismatch: ${item.name}`);
      Object.assign(result, { snapshot: snapshot.snapshot, verified: true });
    }
    results.push(result);
  }
  console.log(JSON.stringify({ account: 'satigertestweb', container: 'reports', apply, affected: results.length, results }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
