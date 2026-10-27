// Copy and verify first. Cleanup requires the saved manifest and explicit Portal acceptance.
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { migrateReports } from '../src/reportMigration.js';

const account = process.env.DASHBOARD_STORAGE_ACCOUNT;
if (!/^[a-z0-9]{3,24}$/.test(account || '')) throw new Error('DASHBOARD_STORAGE_ACCOUNT is required');
const destinationName = process.env.DASHBOARD_CONTAINER || 'reports';
if (!/^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(destinationName) || destinationName.includes('--') || destinationName === 'portal-sessions') {
  throw new Error('Destination must be a dedicated private report container');
}
const apply = process.argv.includes('--apply');
const remove = process.argv.includes('--remove-public');
if (remove && (!apply || !process.argv.includes('--confirm-portal-verified'))) {
  throw new Error('Public removal requires --apply --confirm-portal-verified after live Portal acceptance');
}
const manifestArg = process.argv.indexOf('--manifest');
const manifestPath = manifestArg < 0 ? null : process.argv[manifestArg + 1];
if (apply && (!manifestPath || manifestPath.startsWith('--'))) throw new Error('--manifest <local-file> is required with --apply');
let manifest = { version: 1, account, source: '$web', destination: destinationName, entries: {} };
if (manifestPath) {
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.version !== 1 || manifest.account !== account || manifest.source !== '$web' || manifest.destination !== destinationName ||
        !manifest.entries || typeof manifest.entries !== 'object' || Array.isArray(manifest.entries)) {
      throw new Error('Manifest does not match this storage account and container');
    }
  } catch (error) { if (error.code !== 'ENOENT' || remove) throw error; }
}
const saveManifest = async value => {
  const file = resolve(manifestPath);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, file);
};
const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, new DefaultAzureCredential());
const result = await migrateReports({
  source: service.getContainerClient('$web'), target: service.getContainerClient(destinationName),
  manifest, saveManifest, apply, remove,
});
console.log(JSON.stringify(result));
