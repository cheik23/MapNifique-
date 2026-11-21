import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceScript = path.resolve(here, '../scripts/start.sh');

function runStartScript(readiness) {
  const root = mkdtempSync(path.join(tmpdir(), 'mapnifique-start-test-'));
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'backend', 'scraper');
  const scripts = path.join(project, 'scripts');
  mkdirSync(bin, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  writeFileSync(path.join(project, '.env'), 'TEST_ONLY=true\n');
  const targetScript = path.join(scripts, 'start.sh');
  writeFileSync(targetScript, readFileSync(sourceScript));
  chmodSync(targetScript, 0o755);

  const docker = path.join(bin, 'docker');
  writeFileSync(docker, `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_CALL_LOG"
if [ "$1" = "compose" ] && [ "$2" = "version" ]; then exit 0; fi
if [ "$1" = "compose" ] && [ "$2" = "config" ]; then echo db; exit 0; fi
if [ "$1" = "compose" ] && [ "$2" = "up" ]; then exit 0; fi
if [ "$1" = "compose" ] && [ "$2" = "ps" ]; then echo fake-container-id; exit 0; fi
if [ "$1" = "inspect" ]; then
  case "$3" in
    *State.Status*) echo running ;;
    *Health.Status*) echo healthy ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = "compose" ] && [ "$2" = "exec" ]; then
  cat >/dev/null
  printf '%s\\n' "$DOCKER_FAKE_READINESS"
  exit 0
fi
if [ "$1" = "compose" ] && [ "$2" = "logs" ]; then exit 0; fi
echo "unexpected docker invocation: $*" >&2
exit 90
`);
  chmodSync(docker, 0o755);

  const curl = path.join(bin, 'curl');
  writeFileSync(curl, '#!/bin/sh\necho \'{"status":"ok"}\'\nexit 0\n');
  chmodSync(curl, 0o755);

  const callLog = path.join(root, 'docker-calls.log');
  const result = spawnSync('bash', [targetScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || ''}`,
      DOCKER_CALL_LOG: callLog,
      DOCKER_FAKE_READINESS: readiness,
    },
    timeout: 15000,
  });
  const calls = readFileSync(callLog, 'utf8');
  rmSync(root, { recursive: true, force: true });
  return { result, calls };
}

test('start.sh starts only PostgreSQL and stops when schema is not ready', () => {
  const { result, calls } = runStartScript('missing_schema_state');
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(calls, /compose up -d db/);
  assert.doesNotMatch(calls, /compose up -d --build api worker offers-worker/);
  assert.doesNotMatch(calls, /migrations\/20261120/);
});

test('start.sh starts app services only after schema v2 and places schema checks pass', () => {
  const { result, calls } = runStartScript('ready');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(calls, /compose up -d db/);
  assert.match(calls, /compose exec -T db/);
  assert.match(calls, /compose up -d --build api worker offers-worker/);
});
