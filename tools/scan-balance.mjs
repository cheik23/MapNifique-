// Token-aware depth scanner for main.js
import fs from 'fs';
const path = process.argv[2] || 'src/main.js';
const src = fs.readFileSync(path, 'utf8');
const lines = src.split('\n');

let depth = 0; // { } balance (par ignored for depth printing but tracked together below)
let code = '';
let i = 0, n = src.length;
let state = 'code'; // code | sq | dq | tpl | line | block | tplsub
const stack = [];
let line = 1;
let tplStack = []; // template nesting
const events = [];

// simplified: we walk char by char
let inBlock = false, pending = '';
const deltas = new Array(lines.length + 1).fill(0);
let curLine = 0;

while (i < n) {
  const c = src[i], c2 = src[i+1], c3 = src.slice(i, i+2);
  const c4 = src.slice(i, i+3);
  if (c === '\n') { line++; i++; continue; }
  if (state === 'code') {
    if (c4 === '/**/') { i += 4; continue; }
    if (c3 === '/--') { i += 3; continue; }
    if (c2 === '//') { state = 'line'; i += 2; continue; }
    if (c2 === '/*') { state = 'block'; i += 2; continue; }
    if (c === "'") { state = 'sq'; i++; continue; }
    if (c === '"') { state = 'dq'; i++; continue; }
    if (c === '`') { state = 'tpl'; i++; continue; }
    if (c === '{') { depth++; deltas[line]++; i++; continue; }
    if (c === '}') { depth--; deltas[line]--; i++; continue; }
    i++; continue;
  }
  if (state === 'line') { if (c === '\n') { state = 'code'; }; i++; continue; }
  if (state === 'block') { if (c2 === '*/') { state = 'code'; i += 2; } else i++; continue; }
  if (state === 'sq') { if (c === '\\') { i += 2; continue; } if (c === "'") { state = 'code'; } i++; continue; }
  if (state === 'dq') { if (c === '\\') { i += 2; continue; } if (c === '"') { state = 'code'; } i++; continue; }
  if (state === 'tpl') {
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { state = 'code'; i++; continue; }
    if (c2 === '${') { tplStack.push('tpl'); state = 'code'; i += 2; continue; }
    i++; continue;
  }
}

console.log('final depth (curly):', depth);
// print depth at end of every 10th line + where depth changes touched negative over-dip
let running = 0;
let minDepth = 0, minAt = 0, maxDepth = 0, maxAt = 0;
for (let L = 1; L <= lines.length; L++) {
  running += deltas[L];
  if (running < minDepth) { minDepth = running; minAt = L; }
  if (running > maxDepth) { maxDepth = running; maxAt = L; }
  if (L % 100 === 0 || L === lines.length) console.log('after line', L, 'depth =', running);
}
console.log('min depth', minDepth, 'at line', minAt, '| max depth', maxDepth, 'at line', maxAt);
