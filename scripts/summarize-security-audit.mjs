#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const requestedDir = process.argv[2] ? resolve(process.argv[2]) : null;

function latestAuditDir() {
  const backups = join(root, 'backups');
  if (!existsSync(backups)) return null;
  const candidates = readdirSync(backups, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('security-audit-'))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  return candidates.length ? join(backups, candidates[0]) : null;
}

function advisoryLabels(vulnerability) {
  const via = Array.isArray(vulnerability?.via) ? vulnerability.via : [];
  return [...new Set(via.map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return null;
    return [item.title, item.name, item.url].filter(Boolean).join(' — ') || null;
  }).filter(Boolean))];
}

function summarize(file, project) {
  if (!existsSync(file)) {
    console.log(`\n[${project}] RAPPORT_ABSENT=${file}`);
    return;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.log(`\n[${project}] JSON_INVALIDE=${error.message}`);
    return;
  }

  const metadata = report?.metadata?.vulnerabilities;
  if (!metadata) {
    console.log(`\n[${project}] AUDIT_SANS_METADATA`);
    if (report?.error?.summary) console.log(`ERREUR=${report.error.summary}`);
    if (report?.error?.detail) console.log(`DETAIL=${report.error.detail}`);
    return;
  }

  console.log(`\n[${project}] total=${metadata.total ?? 'n/a'} info=${metadata.info ?? 0} low=${metadata.low ?? 0} moderate=${metadata.moderate ?? 0} high=${metadata.high ?? 0} critical=${metadata.critical ?? 0}`);
  const vulnerabilities = Object.values(report.vulnerabilities ?? {})
    .sort((a, b) => `${a.severity}:${a.name}`.localeCompare(`${b.severity}:${b.name}`));
  for (const item of vulnerabilities) {
    const nodes = Array.isArray(item.nodes) ? item.nodes.join(', ') : '';
    const fixes = item.fixAvailable === undefined ? 'unknown' : JSON.stringify(item.fixAvailable);
    console.log(`- ${item.name}: severity=${item.severity}; direct=${Boolean(item.isDirect)}; range=${item.range ?? 'n/a'}; fix=${fixes}`);
    if (nodes) console.log(`  paths=${nodes}`);
    for (const label of advisoryLabels(item)) console.log(`  advisory=${label}`);
  }
}

const auditDir = requestedDir ?? latestAuditDir();
if (!auditDir || !existsSync(auditDir)) {
  console.error('Aucun dossier security-audit trouvé. Lance d’abord npm run audit:deps.');
  console.error('Usage: npm run audit:deps:summary -- backups/security-audit-AAAAMMJJTHHMMSSZ');
  process.exitCode = 2;
} else {
  console.log(`AUDIT_DIRECTORY=${auditDir}`);
  summarize(join(auditDir, 'backend-scraper.json'), 'backend/scraper');
  summarize(join(auditDir, 'frontend.json'), 'frontend');
  console.log('\nFin du résumé. Aucun package n’a été modifié par ce script.');
}
