import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const { version } = JSON.parse(await readFile('manifest.json', 'utf8'));
const staging = await mkdtemp(join(tmpdir(), 'maps-directions-'));
await mkdir(join(staging, 'maps-directions'));
for (const name of ['main.js', 'manifest.json', 'README.md', 'LICENSE']) {
  await copyFile(`dist/${name}`, join(staging, 'maps-directions', name));
}
const destination = resolve(`dist/maps-directions-${version}.zip`);
execFileSync('zip', ['-q', '-r', destination, 'maps-directions'], { cwd: staging });
console.log(destination);
