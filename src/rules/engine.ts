import { readPackageJson, type PackageInfo, type PackageReadResult } from '../project/package-json.js';
import { newId, nowIso, type Store } from '../store/sqlite.js';
import { listNpmExecutions, type Execution } from '../telemetry/correlation.js';
import { evaluateR001, evidenceFor, RULE_ID, type R001Proposal } from './r001-npm-script.js';

export type HintState = 'candidate' | 'verified' | 'active' | 'stale' | 'disabled' | 'reverted';

export interface HintRow {
  id: string;
  project_id: string;
  package_path: string;
  package_hash: string;
  failed_script: string;
  suggested_script: string;
  state: HintState;
  version: number;
  evidence_event_ids_json: string;
  created_at: string;
  updated_at: string;
  invalidated_reason: string | null;
}

const MAX_EVIDENCE_IDS = 40;

/** States in which a hint may still progress or be injected. */
export const LIVE_STATES: ReadonlySet<HintState> = new Set(['candidate', 'verified', 'active']);

export type InvalidationReason =
  | 'PACKAGE_DELETED'
  | 'PACKAGE_UNREADABLE'
  | 'PACKAGE_CHANGED'
  | 'SCRIPT_REMOVED'
  | 'FAILED_SCRIPT_ADDED'
  | 'MULTIPLE_CANDIDATES'
  | 'CONTRADICTORY_OBSERVATION';

export interface PackageTarget {
  projectId: string;
  projectRoot: string;
  packagePath: string;
}

export function transition(store: Store, hint: HintRow, to: HintState, reason: string | null = null, at = nowIso()): void {
  store.db.prepare('UPDATE hints SET state = ?, invalidated_reason = ?, updated_at = ? WHERE id = ?').run(to, reason, at, hint.id);
  store.audit({ action: `hint.${to}`, objectId: hint.id, reasonCode: reason, metadata: { rule: RULE_ID, from: hint.state } }, at);
  hint.state = to;
  hint.invalidated_reason = reason;
}

export function hintsForPackage(store: Store, packagePath: string): HintRow[] {
  return store.db.prepare('SELECT * FROM hints WHERE package_path = ? ORDER BY created_at, rowid').all(packagePath) as HintRow[];
}

function upsertCandidate(store: Store, t: PackageTarget, pkg: PackageInfo, failed: string, suggested: string, evidence: string[], at: string): HintRow {
  const existing = store.db
    .prepare('SELECT * FROM hints WHERE project_id = ? AND package_path = ? AND failed_script = ? AND suggested_script = ? AND package_hash = ?')
    .get(t.projectId, t.packagePath, failed, suggested, pkg.hash) as HintRow | undefined;
  if (existing) {
    // Keep earlier evidence ids: events may age out of retention, but the record of why a hint
    // was created should not shrink.
    const merged = [...new Set([...parseIds(existing.evidence_event_ids_json), ...evidence])].slice(-MAX_EVIDENCE_IDS);
    store.db.prepare('UPDATE hints SET evidence_event_ids_json = ? WHERE id = ?').run(JSON.stringify(merged), existing.id);
    existing.evidence_event_ids_json = JSON.stringify(merged);
    return existing;
  }
  const id = newId();
  store.db
    .prepare(
      `INSERT INTO hints (id, project_id, package_path, package_hash, failed_script, suggested_script, state, evidence_event_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)`,
    )
    .run(id, t.projectId, t.packagePath, pkg.hash, failed, suggested, JSON.stringify(evidence), at, at);
  store.audit({ action: 'hint.candidate', objectId: id, metadata: { rule: RULE_ID, failed, suggested } }, at);
  return store.db.prepare('SELECT * FROM hints WHERE id = ?').get(id) as HintRow;
}

/** Why a hint bound to an older package.json no longer holds, or null if the evidence still matches. */
export function staleReason(hint: HintRow, read: PackageReadResult): InvalidationReason | null {
  if (!read.ok) return read.reason === 'not_found' ? 'PACKAGE_DELETED' : 'PACKAGE_UNREADABLE';
  if (read.pkg.hash === hint.package_hash) return null;
  if (!read.pkg.scripts.has(hint.suggested_script)) return 'SCRIPT_REMOVED';
  if (read.pkg.scripts.has(hint.failed_script)) return 'FAILED_SCRIPT_ADDED';
  return 'PACKAGE_CHANGED';
}

/** Why an active hint must stop although package.json is unchanged, or null. */
function activeHintProblem(hint: HintRow, proposals: R001Proposal[], executions: Execution[]): InvalidationReason | null {
  const contradicted = executions.some(
    (e) => e.command_name === hint.suggested_script && e.outcome === 'failure' && e.failure_code === 'NPM_MISSING_SCRIPT' && e.package_hash === hint.package_hash,
  );
  if (contradicted) return 'CONTRADICTORY_OBSERVATION';
  const proposal = proposals.find((p) => p.failedScript === hint.failed_script);
  if (!proposal) return null;
  const own = proposal.candidates.find((c) => c.script === hint.suggested_script);
  if (!own || own.successIds.length === 0) {
    // The successes that verified this hint are still stored but no longer count as success
    // (e.g. downgraded to unknown by a Hook/OTel conflict): the evidence was contradicted.
    const evidence = new Set(parseIds(hint.evidence_event_ids_json));
    if (executions.some((e) => evidence.has(e.id) && e.command_name === hint.suggested_script && e.outcome !== 'success')) {
      return 'CONTRADICTORY_OBSERVATION';
    }
    // Otherwise the evidence merely aged out of retention; that alone is no reason to stop.
    return proposal.verified && proposal.verified !== hint.suggested_script ? 'MULTIPLE_CANDIDATES' : null;
  }
  if (proposal.verified !== hint.suggested_script) return 'MULTIPLE_CANDIDATES';
  return null;
}

function parseIds(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Terminal state for each problem: stale when the evidence moved, disabled when it was contradicted. */
function stateFor(reason: InvalidationReason): HintState {
  if (reason === 'CONTRADICTORY_OBSERVATION') return 'disabled';
  if (reason === 'MULTIPLE_CANDIDATES') return 'reverted';
  return 'stale';
}

/**
 * Re-evaluate R001 for one package.json against everything observed there and apply the state
 * machine: observed → candidate → verified → active, then stale / disabled / reverted as soon as
 * the evidence no longer holds. Hints in terminal states are never revived; a changed
 * package.json yields new hint rows (keyed by content hash).
 */
export function evaluatePackage(store: Store, t: PackageTarget, at: string = nowIso()): void {
  const read = readPackageJson(t.packagePath, t.projectRoot);
  store.transaction(() => {
    const live = hintsForPackage(store, t.packagePath).filter((h) => LIVE_STATES.has(h.state));
    for (const hint of live) {
      const reason = staleReason(hint, read);
      if (reason) transition(store, hint, stateFor(reason), reason, at);
    }
    if (!read.ok) return;
    const pkg = read.pkg;
    const executions = listNpmExecutions(store, t.packagePath);
    const proposals = evaluateR001(pkg, executions);
    for (const hint of live.filter((h) => h.state === 'active')) {
      const reason = activeHintProblem(hint, proposals, executions);
      if (reason) transition(store, hint, stateFor(reason), reason, at);
    }
    for (const p of proposals) {
      for (const c of p.candidates) {
        const hint = upsertCandidate(store, t, pkg, p.failedScript, c.script, evidenceFor(p, c.script), at);
        if (c.script !== p.verified || hint.state !== 'candidate') continue;
        transition(store, hint, 'verified', null, at);
        transition(store, hint, 'active', null, at);
      }
    }
  });
}

/**
 * Re-check an active hint against the package.json on disk right before it is injected. A hint
 * whose evidence no longer matches is invalidated immediately and must not be shown.
 */
export function revalidateForInjection(store: Store, hint: HintRow, projectRoot: string, at: string = nowIso()): boolean {
  if (hint.state !== 'active') return false;
  const reason = staleReason(hint, readPackageJson(hint.package_path, projectRoot));
  if (!reason) return true;
  transition(store, hint, stateFor(reason), reason, at);
  return false;
}
