import { readPackageJson, type PackageInfo } from '../project/package-json.js';
import { newId, nowIso, type Store } from '../store/sqlite.js';
import { listNpmExecutions } from '../telemetry/correlation.js';
import { evaluateR001, evidenceFor, RULE_ID } from './r001-npm-script.js';

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
  return store.db.prepare('SELECT * FROM hints WHERE package_path = ? ORDER BY created_at').all(packagePath) as HintRow[];
}

function upsertCandidate(store: Store, t: PackageTarget, pkg: PackageInfo, failed: string, suggested: string, evidence: string[], at: string): HintRow {
  const existing = store.db
    .prepare('SELECT * FROM hints WHERE project_id = ? AND package_path = ? AND failed_script = ? AND suggested_script = ? AND package_hash = ?')
    .get(t.projectId, t.packagePath, failed, suggested, pkg.hash) as HintRow | undefined;
  if (existing) {
    store.db.prepare('UPDATE hints SET evidence_event_ids_json = ? WHERE id = ?').run(JSON.stringify(evidence), existing.id);
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

/**
 * Re-evaluate R001 for one package.json against everything observed there and apply the state
 * machine: observed → candidate → verified → active. Hints in terminal states are never revived;
 * a changed package.json yields new hint rows (keyed by content hash).
 */
export function evaluatePackage(store: Store, t: PackageTarget, at: string = nowIso()): void {
  const read = readPackageJson(t.packagePath, t.projectRoot);
  if (!read.ok) return;
  const pkg = read.pkg;
  const proposals = evaluateR001(pkg, listNpmExecutions(store, t.packagePath));
  store.transaction(() => {
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
