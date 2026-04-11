import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data']);
const MARKER_RE = /^(<<<<<<< .+|=======|>>>>>>> .+)$/m;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
      continue;
    }
    out.push(path.join(dir, entry.name));
  }
  return out;
}

function isTextCandidate(file) {
  const ext = path.extname(file).toLowerCase();
  return ['.js', '.mjs', '.cjs', '.ejs', '.json', '.md', '.css', '.html', '.yml', '.yaml'].includes(ext);
}

const files = walk(ROOT).filter(isTextCandidate);
const offenders = [];
for (const file of files) {
  let txt = '';
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (MARKER_RE.test(txt)) offenders.push(path.relative(ROOT, file));
}

if (offenders.length) {
  console.error('Merge conflict markers found in:');
  for (const f of offenders) console.error(` - ${f}`);
  process.exit(1);
}

console.log('No merge conflict markers found.');

