import { fileURLToPath } from 'node:url';

export default {
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
  poweredByHeader: false,
  // Keep legacy report paths as-is; the authorization server handles directory redirects.
  skipTrailingSlashRedirect: true,
};
