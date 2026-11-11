#!/usr/bin/env node
// Measure the wall-clock latency Claude Code waits for on each AutoTune hook (spec §11: p95 ≤ 100 ms).
// Runs against the built CLI with a throwaway HOME, a real daemon and real hook processes.
//   npm run build && node scripts/bench-hook.mjs [iterations]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const N = Number(process.argv[2] ?? 50);
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const fixture = (n) => JSON.parse(readFileSync(new URL(`../tests/fixtures/hooks/${n}`, import.meta.url), 'utf8'));

const home = mkdtempSync(join(tmpdir(), 'aat-bench-'));
const project = join(home, 'project');
mkdirSync(join(project, '.git'), { recursive: true });
writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'vitest' } }));
const env = { PATH: process.env.PATH, HOME: home };

const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const init = spawnSync(process.execPath, [CLI, 'init', '--yes', '--no-launchd', '--port', String(port)], { env, encoding: 'utf8' });
if (init.status !== 0) throw new Error(init.stderr);
const daemon = spawn(process.execPath, [CLI, 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise((resolve) => daemon.stderr.on('data', (c) => String(c).includes('listening') && resolve()));

function time(args, input) {
  const t = process.hrtime.bigint();
  spawnSync(process.execPath, args, { env, input });
  return Number(process.hrtime.bigint() - t) / 1e6;
}
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { p50: q(0.5), p95: q(0.95), max: s.at(-1) };
};

let id = 0;
const payloads = {
  PostToolUse: () => ({ ...fixture('post-tool-use-success-test-unit.json'), cwd: project, tool_use_id: `toolu_bench${++id}` }),
  PostToolUseFailure: () => ({ ...fixture('post-tool-use-failure-missing-script.json'), cwd: project, tool_use_id: `toolu_bench${++id}` }),
  SessionStart: () => ({ ...fixture('session-start.json'), cwd: project, session_id: `bench-${++id}` }),
};

const baseline = stats(Array.from({ length: N }, () => time(['-e', ''], '')));
const rows = [['node -e "" (baseline)', baseline]];
for (const [event, make] of Object.entries(payloads)) {
  rows.push([`hook ${event}`, stats(Array.from({ length: N }, () => time([CLI, 'hook', event], JSON.stringify(make()))))]);
}
daemon.kill('SIGTERM');
rmSync(home, { recursive: true, force: true });

const fmt = (v) => `${v.toFixed(1)} ms`.padStart(9);
console.log(`node ${process.version}, ${process.platform}/${process.arch}, ${N} runs each`);
console.log(`${'case'.padEnd(26)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'max'.padStart(9)}  p95 added over baseline`);
for (const [name, s] of rows) {
  const added = name.startsWith('hook') ? `${(s.p95 - baseline.p95).toFixed(1)} ms` : '';
  console.log(`${name.padEnd(26)}${fmt(s.p50)}${fmt(s.p95)}${fmt(s.max)}  ${added}`);
}
