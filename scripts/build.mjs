import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';
const tests = (await readdir('src')).filter(name => name.endsWith('.test.ts')).map(name => `src/${name}`);
await build({ entryPoints: ['src/server.ts', 'src/queue-worker.ts', 'src/verifier-worker.ts', ...tests], bundle: true, platform: 'node', target: 'node24', format: 'esm', outdir: 'dist', packages: 'external', sourcemap: true });
