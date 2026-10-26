import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const worker = await build({
  entryPoints: ['src/local-routing-worker.ts'], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: 'es2020', minify: true,
});
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  define: { __LOCAL_ROUTING_WORKER__: JSON.stringify(worker.outputFiles[0].text) },
  legalComments: 'eof',
  outfile: 'dist/main.js',
});
for (const file of ['manifest.json', 'README.md', 'LICENSE']) await copyFile(file, `dist/${file}`);
console.log('Built Maps Directions. The map runtime is supplied by official Maps.');
