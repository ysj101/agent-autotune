import { existsSync } from 'node:fs';
import { resolvePaths, type Paths } from '../config/paths.js';
import { RULE_ID } from '../rules/r001-npm-script.js';
import { openStore, type Store } from '../store/sqlite.js';
import { consoleIo, type Io } from './common.js';
import { displayPath, loadHints, missingText, successText, validationText, type HintView } from './hint-view.js';

export const SHORT_ID_LENGTH = 8;

export interface RulesOptions {
  state?: string;
  json?: boolean;
}

export interface RulesDeps {
  paths: Paths;
  io: Io;
}

interface Evidence {
  failures: number;
  successes: number;
}

function evidence(store: Store, h: HintView): Evidence {
  let ids: unknown;
  try {
    ids = JSON.parse(h.evidence_event_ids_json);
  } catch {
    ids = [];
  }
  const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  if (list.length === 0) return { failures: 0, successes: 0 };
  const rows = store.db.prepare(`SELECT outcome FROM tool_events WHERE id IN (${list.map(() => '?').join(',')})`).all(...list) as { outcome: string }[];
  return { failures: rows.filter((r) => r.outcome === 'failure').length, successes: rows.filter((r) => r.outcome === 'success').length };
}

function deliveries(store: Store, h: HintView): number {
  return (store.db.prepare('SELECT COUNT(DISTINCT session_id) n FROM hint_deliveries WHERE hint_id = ?').get(h.id) as { n: number }).n;
}

export async function runRules(opts: RulesOptions, deps: RulesDeps = { paths: resolvePaths(), io: consoleIo }): Promise<number> {
  const { paths, io } = deps;
  if (!existsSync(paths.dbFile)) {
    io.out(opts.json ? '[]' : 'No hints yet.');
    return 0;
  }
  const store = openStore(paths.dbFile);
  try {
    const hints = loadHints(store, opts.state ? [opts.state] : undefined);
    const rows = hints.map((h) => ({
      id: h.id,
      rule: RULE_ID,
      state: h.state,
      package: displayPath(h),
      missing: missingText(h),
      suggested: successText(h),
      evidence: evidence(store, h),
      validation: validationText(h),
      deliveredSessions: deliveries(store, h),
      invalidatedReason: h.invalidated_reason,
      createdAt: h.created_at,
      updatedAt: h.updated_at,
    }));
    if (opts.json) {
      io.out(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (rows.length === 0) {
      io.out(opts.state ? `No hints in state ${opts.state}.` : 'No hints yet.');
      return 0;
    }
    for (const r of rows) {
      io.out(`${r.id.slice(0, SHORT_ID_LENGTH)}  [${r.state}] ${r.package}  (${r.rule})`);
      io.out(`  ${r.missing} → ${r.suggested}`);
      io.out(`  evidence: ${r.evidence.failures} failure(s), ${r.evidence.successes} success(es); delivered to ${r.deliveredSessions} session(s)`);
      io.out(`  validation: ${r.validation}`);
      if (r.invalidatedReason) io.out(`  stopped: ${r.invalidatedReason}`);
      io.out(`  updated: ${r.updatedAt}`);
    }
    io.out('');
    io.out('Disable one with `agent-autotune disable --rule <id>`.');
  } finally {
    store.close();
  }
  return 0;
}
