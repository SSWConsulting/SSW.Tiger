import { fileURLToPath } from 'node:url';

export default {
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
  poweredByHeader: false,
  // 保留旧报告的路径格式，目录跳转仍由鉴权服务处理。
  skipTrailingSlashRedirect: true,
};
