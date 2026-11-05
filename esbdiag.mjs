import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const src = fs.readFileSync('src/main.js', 'utf8');
try {
  await esbuild.transform(src, { loader: 'js', format: 'esm' });
  console.log('ESBUILD OK');
} catch (e) {
  const errs = e.errors || [];
  console.log('errors:', errs.length);
  for (const er of errs.slice(0, 5)) {
    console.log('---', er.text);
    if (er.location) console.log('line', er.location.line, 'col', er.location.column, '|', er.location.lineText);
  }
}
