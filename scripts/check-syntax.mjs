import { readdirSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';

const roots = ['server.js', 'db.js', 'lib', 'middleware', 'routes', 'scripts', 'tests'];

function collect(target) {
  const stat = statSync(target);
  if (stat.isFile()) return target.endsWith('.js') || target.endsWith('.mjs') ? [target] : [];
  return readdirSync(target).flatMap((entry) => collect(path.join(target, entry)));
}

for (const file of roots.flatMap(collect)) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('Syntax check passed.');
