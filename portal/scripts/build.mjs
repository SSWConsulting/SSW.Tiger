import { cp, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function build({ directory = process.cwd(), cache = process.env.PORTAL_BUILD_CACHE_DIR,
  run = () => new Promise((resolveBuild, reject) => {
    const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'build', '--webpack'], {
      cwd: directory, stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolveBuild() : reject(new Error(`Next.js build failed (${signal || code})`)));
  }), log = console.log } = {}) {
  const local = resolve(directory, '.next/cache');
  // Cache compiler output only; never pages, sessions or user data.
  async function copyCache(from, to, phase) {
    try {
      if (phase === 'saved') await rm(to, { recursive: true, force: true });
      await mkdir(to, { recursive: true });
      await cp(from, to, { recursive: true });
      log(`Portal build cache ${phase}.`);
    } catch (error) {
      if (error.code === 'ENOENT') log(`Portal build cache ${phase}: cold cache.`);
      else log(`Portal build cache ${phase} unavailable (${error.code}); continuing without cache.`);
    }
  }
  if (cache) await copyCache(resolve(cache), local, 'restored');
  await run();
  if (cache) await copyCache(local, resolve(cache), 'saved');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await build();
