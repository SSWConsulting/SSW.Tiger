import { fileURLToPath } from 'node:url';

export default {
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
  // App Service keeps the full node_modules, so skip scanning it to trim dependencies.
  outputFileTracingExcludes: { '*': ['**/node_modules/**'] },
  poweredByHeader: false,
  // Keep legacy report paths as-is; the authorization server handles directory redirects.
  skipTrailingSlashRedirect: true,
};
