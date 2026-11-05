// Correct-ish JS scanner: tracks { } depth, skipping strings, comments, template literals and their ${ } interpolations recursively.
import fs from 'fs';
const src = fs.readFileSync(process.argv[2] || 'src/main.js', 'utf8');
let i = 0, n = src.length, line = 1;
// modeStack entries: 'code'
const stack = ['code'];
let depth = 0;
let lastZeroLine = 0;
let firstNegative = null;
let openStack = []; // {char,line}
const timeline = [];

while (i < n) {
  const c = src[i], d = src[i + 1];
  const mode = stack[stack.length - 1];
  if (c === '\n') { line++; i++; continue; }
  if (mode === 'code') {
    if (c === '/' && d === '/') { stack.push('line'); i += 2; continue; }
    if (c === '/' && d === '*') { stack.push('block'); i += 2; continue; }
    if (c === "'") { stack.push('sq'); i++; continue; }
    if (c === '"') { stack.push('dq'); i++; continue; }
    if (c === '`') { stack.push('tpl'); i++; continue; }
    if (c === '{') { depth++; openStack.push({ ch: '{', line }); i++; continue; }
    if (c === '}') { depth--; if (depth === 0) lastZeroLine = line; if (depth < 0 && firstNegative === null) firstNegative = line; openStack.pop(); i++; continue; }
    if (c === '(') { openStack.push({ ch: '(', line }); i++; continue; }
    if (c === ')') { openStack.pop(); i++; continue; }
    i++; continue;
  }
  if (mode === 'line') { i++; if (c === '\n' || c === '\r') stack.pop(); continue; }
  if (mode === 'block') { if (c === '*' && d === '/') { stack.pop(); i += 2; } else i++; continue; }
  if (mode === 'sq') { if (c === '\\') i += 2; else { if (c === "'") stack.pop(); i++; } continue; }
  if (mode === 'dq') { if (c === '\\') i += 2; else { if (c === '"') stack.pop(); i++; } continue; }
  if (mode === 'tpl') { if (c === '\\') i += 2; else if (c === '`') { stack.pop(); i++; } else if (c === '$' && d === '{') { stack.push('tplsub'); i += 2; } else i++; continue; }
  if (mode === 'tplsub') {
    // same as code, but '}' returns to tpl when depth matches at entry
    if (c === '/' && d === '/') { stack.push('line'); i += 2; continue; }
    if (c === '/' && d === '*') { stack.push('block'); i += 2; continue; }
    if (c === "'") { stack.push('sq'); i++; continue; }
    if (c === '"') { stack.push('dq'); i++; continue; }
    if (c === '`') { stack.push('tpl'); i++; continue; }
    if (c === '{') { depth++; openStack.push({ ch: '{', line }); i++; continue; }
    if (c === '}') {
      if (depth === 0) { stack.pop(); i++; continue; } // end interpolation -> back to tpl
      depth--; openStack.pop(); i++; continue;
    }
    i++; continue;
  }
}

console.log('final depth:', depth);
console.log('last line reaching code-depth 0:', lastZeroLine);
console.log('first negative:', firstNegative);
console.log('unclosed open-stack top entries:');
for (const o of openStack.slice(-5)) console.log(' ', o.ch, 'opened at line', o.line);
// context print
const lines = src.split('\n');
for (const o of openStack.slice(-5)) {
  for (let k = Math.max(0, o.line - 1); k < Math.min(lines.length, o.line + 2); k++) console.log((k + 1) + ': ' + lines[k]);
  console.log('   ---');
}
