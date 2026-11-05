import fs from 'fs';
import { parseSync } from 'rolldown/experimental';

const file = process.argv[2] || 'src/main.js';
const src = fs.readFileSync(file, 'utf8');
const r = parseSync(file, src, { sourceType: 'module' });
const errs = r.errors || [];
if (!errs.length) { console.log('PARSE OK'); process.exit(0); }
console.log('errors:', errs.length);
for (const er of errs.slice(0, 6)) {
  const l = er.location || {};
  console.log('---', er.message);
  console.log('line', l.start?.line, 'col', l.start?.column, '::', String(l.line ?? '').trim());
}
