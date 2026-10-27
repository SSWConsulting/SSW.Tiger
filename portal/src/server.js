import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { createStorage } from './storage.js';
import { createAuth } from './auth.js';
import { createHandler } from './app.js';

const config = loadConfig();
const storage = createStorage(config);
// Initialize discovery on first sign-in so temporary outages do not affect existing sessions.
let pendingAuth;
const getAuth = () => pendingAuth ||= createAuth(config).catch(error => { pendingAuth = undefined; throw error; });
const auth = {
  begin: async () => (await getAuth()).begin(),
  finish: async (...args) => (await getAuth()).finish(...args),
  logout: async idToken => (await getAuth()).logout(idToken),
};
const server = createServer(createHandler({ config, ...storage, auth }));
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(config.port, () => console.log(`TIGER Portal listening on ${config.port}`));
process.on('SIGTERM', () => server.close());
