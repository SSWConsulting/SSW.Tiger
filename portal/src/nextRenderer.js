import next from 'next';
import { fileURLToPath, parse } from 'node:url';

export async function createNextRenderer({ dev = false } = {}) {
  const app = next({ dev, dir: fileURLToPath(new URL('../', import.meta.url)) });
  await app.prepare();
  const handle = app.getRequestHandler();
  return {
    serveAssets: handle,
    async renderPage(req, res, props) {
      // 只传递展示数据，令牌和完整会话留在服务端；移除 Next.js 不支持的 undefined。
      req.portalPage = JSON.parse(JSON.stringify(props));
      // 仅在鉴权后将首页和项目页交给同一个 Next.js 页面渲染。
      await handle(req, res, { ...parse(req.url, true), pathname: '/', query: {} });
    },
    close: () => app.close(),
  };
}
