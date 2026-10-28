import next from 'next';
import { fileURLToPath, parse } from 'node:url';

export async function createNextRenderer({ dev = false } = {}) {
  const app = next({ dev, dir: fileURLToPath(new URL('../', import.meta.url)) });
  await app.prepare();
  const handle = app.getRequestHandler();
  return {
    serveAssets: handle,
    async renderPage(req, res, props) {
      // Pass display data only; tokens and the full session stay server-side. JSON round-trip drops undefined, which Next.js rejects.
      req.portalPage = JSON.parse(JSON.stringify(props));
      // Only called after authorization: home and project pages share one Next.js page.
      await handle(req, res, { ...parse(req.url, true), pathname: '/', query: {} });
    },
    close: () => app.close(),
  };
}
