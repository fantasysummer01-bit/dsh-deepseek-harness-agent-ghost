import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, 'artifacts');
fs.mkdirSync(out, { recursive: true });
const stageRoot = fs.mkdtempSync(path.join(out, 'pack-'));
const staging = path.join(stageRoot, 'package');
fs.mkdirSync(staging, { recursive: true });
for (const name of ['package.json', ...pkg.files]) {
  const source = path.join(root, name);
  if (fs.existsSync(source)) fs.cpSync(source, path.join(staging, name), { recursive: true });
}
const target = path.join(out, `${pkg.name}-${pkg.version}.tgz`);
execFileSync('tar', ['-czf', target, '-C', path.dirname(staging), 'package'], { stdio: 'inherit' });
// Remove only this invocation's newly-created staging directory inside artifacts.
if (path.dirname(path.resolve(stageRoot)) !== path.resolve(out) || !path.basename(stageRoot).startsWith('pack-')) {
  throw new Error('Unexpected package staging path');
}
fs.rmSync(stageRoot, { recursive: true, force: true });
console.log(target);
