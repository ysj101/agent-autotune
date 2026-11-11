import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readConfig } from '../config/app-config.js';
import { resolvePaths, type Paths } from '../config/paths.js';
import { readToken } from '../security/local-token.js';
import { dailyMetrics } from '../store/metrics.js';
import { openStore, type Store } from '../store/sqlite.js';
import { countExecutions } from '../telemetry/correlation.js';
import { VERSION } from '../version.js';
import { consoleIo, daemonHealth, type Health, type Io } from './common.js';
import { displayPath, loadHints, missingText, successText, validationText, type HintView } from './hint-view.js';

const DAY_MS = 86_400_000;
/** Below this many sessions on either side of the first delivery, no effect is reported. */
export const MIN_SESSIONS_FOR_EFFECT = 5;
const CONNECTED_WITHIN_MS = DAY_MS;

export interface StatusDeps {
  paths: Paths;
  io: Io;
  now: () => Date;
  claudeVersion: () => string | null;
  health: (port: number, token: string) => Promise<Health | null>;
}

export function defaultStatusDeps(): StatusDeps {
  return {
    paths: resolvePaths(),
    io: consoleIo,
    now: () => new Date(),
    claudeVersion: () => {
      const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
      return r.status === 0 ? (/(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null) : null;
    },
    health: daemonHealth,
  };
}

export interface Effect {
  verdict: 'insufficient_data' | 'observed';
  detail: string;
}

/**
 * Compare Missing-script failures of the hinted script in its package before and after the first
 * delivery. This is shown as a trend only: different tasks are not comparable, so no causal claim
 * is made, and too few sessions yield `insufficient_data`.
 */
export function hintEffect(store: Store, h: HintView): Effect {
  const first = store.db.prepare('SELECT MIN(delivered_at) t FROM hint_deliveries WHERE hint_id = ?').get(h.id) as { t: string | null };
  if (!first.t) return { verdict: 'insufficient_data', detail: 'not delivered yet' };
  const side = (op: '<' | '>='): { sessions: number; failures: number } =>
    store.db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) sessions,
                COUNT(CASE WHEN command_name = ? AND failure_code = 'NPM_MISSING_SCRIPT' THEN 1 END) failures
         FROM tool_events WHERE source = 'hook' AND package_path = ? AND observed_at ${op} ?`,
      )
      .get(h.failed_script, h.package_path, first.t) as { sessions: number; failures: number };
  const before = side('<');
  const after = side('>=');
  if (before.sessions < MIN_SESSIONS_FOR_EFFECT || after.sessions < MIN_SESSIONS_FOR_EFFECT) {
    return { verdict: 'insufficient_data', detail: `sessions before/after first hint: ${before.sessions}/${after.sessions}, need ${MIN_SESSIONS_FOR_EFFECT} each` };
  }
  return {
    verdict: 'observed',
    detail: `\`${missingText(h)}\` missing-script failures: ${before.failures} in ${before.sessions} sessions before, ${after.failures} in ${after.sessions} after (trend only, not causal)`,
  };
}

function connection(store: Store, key: string, now: Date): string {
  const d = store.diagnostics()[key];
  if (!d) return 'no data yet';
  return now.getTime() - Date.parse(d.lastAt) <= CONNECTED_WITHIN_MS ? 'connected' : `last seen ${d.lastAt}`;
}

function formatNumber(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export async function runStatus(deps: StatusDeps = defaultStatusDeps()): Promise<number> {
  const { paths, io } = deps;
  const now = deps.now();
  const config = readConfig(paths);
  io.out(`Agent AutoTune v${VERSION}  [${config.enabled ? 'enabled' : 'disabled'}]`);
  const claude = deps.claudeVersion();
  io.out(`Claude Code: ${claude ? `detected (${claude})` : 'not found'}`);
  const token = readToken(paths);
  const health = token ? await deps.health(config.port, token) : null;
  io.out(`Daemon: ${health ? `running on 127.0.0.1:${config.port}` : 'not reachable (see `agent-autotune doctor`)'}`);
  if (!existsSync(paths.dbFile)) {
    io.out('No data yet. Run `agent-autotune init` and use `claude` as usual.');
    return 0;
  }

  const store = openStore(paths.dbFile);
  try {
    io.out(`OTLP logs: ${connection(store, 'otlp.logs.received', now)}    OTLP metrics: ${connection(store, 'otlp.metrics.received', now)}`);
    const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
    const failures = (store.db.prepare("SELECT COUNT(*) n FROM tool_events WHERE source = 'hook' AND failure_code IS NOT NULL AND observed_at >= ?").get(since) as { n: number }).n;
    io.out(`Observed tools (7d): ${countExecutions(store, since)} | Classified failures: ${failures}`);
    const counts = Object.fromEntries((store.db.prepare('SELECT state, COUNT(*) n FROM hints GROUP BY state').all() as { state: string; n: number }[]).map((r) => [r.state, r.n]));
    const c = (s: string): number => counts[s] ?? 0;
    io.out(`Active hints: ${c('active')} | Candidates: ${c('candidate') + c('verified')} | Stale: ${c('stale')} | Disabled: ${c('disabled')} | Reverted: ${c('reverted')}`);
    const conflicts = store.diagnostics()['outcome_conflict']?.count ?? 0;
    if (conflicts) io.out(`Hook/OTel outcome conflicts: ${conflicts} (treated as unknown)`);

    for (const h of loadHints(store, ['active'])) {
      io.out('');
      io.out(`[${h.state}] ${displayPath(h)}`);
      io.out(`  Missing: ${missingText(h)}`);
      io.out(`  Observed success: ${successText(h)}`);
      io.out(`  Last validation: ${validationText(h)}`);
      const e = hintEffect(store, h);
      io.out(`  Effect: ${e.verdict} (${e.detail})`);
    }
    if (c('active') === 0) io.out('Effect: insufficient_data (no active hint yet)');

    const usage = dailyMetrics(store, since.slice(0, 10));
    const sum = (k: 'sessions' | 'tokens' | 'costUsd'): number | null => {
      const vals = usage.map((d) => d[k]).filter((v): v is number => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };
    const s = sum('sessions');
    const t = sum('tokens');
    const cost = sum('costUsd');
    io.out('');
    io.out(
      `Usage (7d, as exported by Claude Code): sessions ${s === null ? 'N/A' : formatNumber(s)} | tokens ${t === null ? 'N/A' : formatNumber(t)} | cost ${cost === null ? 'N/A' : `$${cost.toFixed(2)}`}`,
    );
  } finally {
    store.close();
  }
  return 0;
}
