import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { createStorage } from './storage.js';
import { createAuth } from './auth.js';
import { createHandler } from './app.js';
import { createApiAuth } from './apiAuth.js';

const config = loadConfig();
const storage = createStorage(config);
// Initialize discovery on first sign-in so temporary outages do not affect existing sessions.
let pendingAuth;
const getAuth = () => pendingAuth ||= createAuth(config).catch(error => { pendingAuth = undefined; throw error; });
const auth = {
  begin: async () => (await getAuth()).begin(),
  finish: async (...args) => (await getAuth()).finish(...args),
  refresh: async session => (await getAuth()).refresh(session),
  revoke: async token => (await getAuth()).revoke(token),
  logout: async idToken => (await getAuth()).logout(idToken),
};
// Store the commit in the release package to avoid mistaking an old process for a successful deployment.
const release = await readFile(new URL('../release.json', import.meta.url), 'utf8')
  .then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return { revision: 'development' }; throw error; });
const server = createServer(createHandler({ config, ...storage, auth, apiAuth: createApiAuth(config), revision: release.revision }));
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(config.port, () => console.log(`TIGER Portal listening on ${config.port}`));
process.on('SIGTERM', () => server.close());
