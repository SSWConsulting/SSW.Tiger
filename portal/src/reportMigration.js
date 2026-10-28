import { createHash } from 'node:crypto';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const isIndex = name => name === 'index.html' || /^[^/]+\/index\.html$/.test(name);

async function snapshot(blob) {
  const properties = await blob.getProperties();
  const bytes = await blob.downloadToBuffer(0, undefined, { conditions: { ifMatch: properties.etag } });
  return { hash: digest(bytes), etag: properties.etag, modified: properties.lastModified?.toISOString() || '' };
}

function checkTarget(name, current, entry) {
  if (current.hash === entry.sha256) return;
  // Only generated indexes may advance after cutover. Report/password pages must still match.
  if (isIndex(name) && current.etag !== entry.targetEtag && entry.targetModified &&
      Date.parse(current.modified) > Date.parse(entry.targetModified)) return;
  throw new Error(`Different destination content; stop and reconcile: ${name}`);
}

export async function migrateReports({ source, target, manifest, saveManifest, apply = false, remove = false }) {
  // Container properties expose public access without requiring the Get Container ACL permission.
  if ((await target.getProperties()).blobPublicAccess) throw new Error('Destination container must be private');
  if (remove && !apply) throw new Error('Cleanup requires apply mode');
  if (apply && (!manifest || !saveManifest)) throw new Error('A durable migration manifest is required');
  const removals = [];
  let count = 0;
  for await (const item of source.listBlobsFlat({ includeMetadata: true })) {
    count++;
    if (!apply) continue;
    const from = source.getBlockBlobClient(item.name);
    const to = target.getBlockBlobClient(item.name);
    const bytes = await from.downloadToBuffer(0, undefined, { conditions: { ifMatch: item.properties.etag } });
    const hash = digest(bytes);
    let entry = Object.hasOwn(manifest.entries, item.name) ? manifest.entries[item.name] : undefined;
    if (entry) {
      if (entry.sourceEtag !== item.properties.etag || entry.sha256 !== hash) {
        throw new Error(`Source changed since migration; stop and reconcile: ${item.name}`);
      }
      checkTarget(item.name, await snapshot(to), entry);
    } else {
      // Cleanup must never manufacture evidence for a file that was not copied previously.
      if (remove) throw new Error(`Missing migration record; copy and verify first: ${item.name}`);
      try {
        await to.upload(bytes, bytes.length, {
          conditions: { ifNoneMatch: '*' },
          // The SDK may parse empty metadata from historical blobs as an empty string.
          metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
          // Keep the source's content headers; only cache control is reset because the Portal serves every report with no-store.
          blobHTTPHeaders: {
            blobContentType: item.properties.contentType, blobContentEncoding: item.properties.contentEncoding,
            blobContentLanguage: item.properties.contentLanguage, blobContentDisposition: item.properties.contentDisposition,
            blobCacheControl: 'no-cache, max-age=0, must-revalidate',
          },
        });
      } catch (error) { if (![409, 412].includes(error.statusCode)) throw error; }
      const verified = await snapshot(to);
      if (verified.hash !== hash) throw new Error(`Different destination content; stop and reconcile: ${item.name}`);
      entry = { sourceEtag: item.properties.etag, sha256: hash, targetEtag: verified.etag, targetModified: verified.modified };
      manifest.entries[item.name] = entry;
      // Persist evidence before proceeding, so a partial copy can resume safely.
      await saveManifest(manifest);
    }
    if (remove) removals.push({ blob: from, etag: entry.sourceEtag });
  }
  // Preflight every listed file before deleting any public source. ETags catch concurrent writes.
  for (const { blob, etag } of removals) await blob.delete({ conditions: { ifMatch: etag } });
  return { mode: remove ? 'verified-removed' : apply ? 'copied-verified' : 'dry-run', blobCount: count };
}
