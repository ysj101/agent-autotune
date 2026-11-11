import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HookToolEvent } from '../../src/hooks/types.js';
import { readPackageJson } from '../../src/project/package-json.js';
import { evaluatePackage, hintsForPackage } from '../../src/rules/engine.js';
import { evaluateR001, isRelatedScript } from '../../src/rules/r001-npm-script.js';
import { ensureProject } from '../../src/store/projects.js';
import { openStore, type Store } from '../../src/store/sqlite.js';
import { recordHookToolEvent, type Execution } from '../../src/telemetry/correlation.js';
import { makeProject } from '../helpers/project.js';

const exec = (id: string, command_name: string, outcome: Execution['outcome'], failure_code: string | null = null): Execution => ({
  id,
  session_id: 's',
  tool_use_id: id,
  observed_at: '2026-11-11T00:00:00.000Z',
  package_path: '/p/package.json',
  package_hash: 'h',
  command_name,
  outcome,
  failure_code,
  duration_ms: null,
});
const pkg = (...scripts: string[]) => ({ path: '/p/package.json', hash: 'h', scripts: new Set(scripts) });

describe('isRelatedScript', () => {
  it('matches the script family and aliases only', () => {
    expect(isRelatedScript('test', 'test:unit')).toBe(true);
    expect(isRelatedScript('test', 'test-ci')).toBe(true);
    expect(isRelatedScript('test', 'tests')).toBe(true);
    expect(isRelatedScript('test', 'test')).toBe(false);
    expect(isRelatedScript('test', 'testing')).toBe(false);
    expect(isRelatedScript('test', 'build')).toBe(false);
    expect(isRelatedScript('build', 'tests')).toBe(false);
  });
});

describe('evaluateR001', () => {
  it('verifies the single related script that succeeded', () => {
    const [p] = evaluateR001(pkg('test:unit', 'build'), [exec('f1', 'test', 'failure', 'NPM_MISSING_SCRIPT'), exec('s1', 'test:unit', 'success')]);
    expect(p).toEqual({ failedScript: 'test', failureIds: ['f1'], candidates: [{ script: 'test:unit', successIds: ['s1'] }], verified: 'test:unit' });
  });

  it('keeps candidates unverified without an observed success', () => {
    const [p] = evaluateR001(pkg('test:unit'), [exec('f1', 'test', 'failure', 'NPM_MISSING_SCRIPT'), exec('s1', 'test:unit', 'unknown')]);
    expect(p?.verified).toBeNull();
    expect(p?.candidates).toEqual([{ script: 'test:unit', successIds: [] }]);
  });

  it('does not apply when several candidates succeeded', () => {
    const [p] = evaluateR001(pkg('test:unit', 'test:e2e'), [
      exec('f1', 'test', 'failure', 'NPM_MISSING_SCRIPT'),
      exec('s1', 'test:unit', 'success'),
      exec('s2', 'test:e2e', 'success'),
    ]);
    expect(p?.verified).toBeNull();
    expect(p?.candidates).toHaveLength(2);
  });

  it('ignores a success of an unrelated script', () => {
    expect(evaluateR001(pkg('check'), [exec('f1', 'test', 'failure', 'NPM_MISSING_SCRIPT'), exec('s1', 'check', 'success')])).toEqual([]);
  });

  it('ignores failures of scripts that exist now and interrupted/unknown failures', () => {
    expect(evaluateR001(pkg('test', 'test:unit'), [exec('f1', 'test', 'failure', 'NPM_MISSING_SCRIPT')])).toEqual([]);
    expect(evaluateR001(pkg('test:unit'), [exec('f1', 'test', 'unknown')])).toEqual([]);
  });

  it('accepts a non-zero exit when the script is absent from package.json', () => {
    const [p] = evaluateR001(pkg('test:unit'), [exec('f1', 'test', 'failure', 'EXIT_NONZERO'), exec('s1', 'test:unit', 'success')]);
    expect(p?.verified).toBe('test:unit');
  });
});

describe('evaluatePackage', () => {
  let n = 0;
  function record(store: Store, root: string, projectId: string, name: string, outcome: HookToolEvent['outcome'], failure: HookToolEvent['failure_code'] = null): void {
    const path = join(root, 'package.json');
    const read = readPackageJson(path, root);
    recordHookToolEvent(
      store,
      { kind: 'tool', event_type: outcome === 'success' ? 'PostToolUse' : 'PostToolUseFailure', session_id: 's', tool_use_id: `t${++n}`, prompt_id: null, cwd: root, command_family: 'npm_script', command_name: name, outcome, failure_code: failure, duration_ms: null },
      { projectId, packagePath: path, packageHash: read.ok ? read.pkg.hash : null },
    );
  }

  function setup(scripts: Record<string, string>): { store: Store; root: string; target: { projectId: string; projectRoot: string; packagePath: string } } {
    const store = openStore(':memory:');
    const root = makeProject(scripts);
    const project = ensureProject(store, root);
    return { store, root, target: { projectId: project.id, projectRoot: root, packagePath: join(root, 'package.json') } };
  }

  it('walks candidate → verified → active with an audit trail', () => {
    const { store, root, target } = setup({ 'test:unit': 'vitest' });
    record(store, root, target.projectId, 'test', 'failure', 'NPM_MISSING_SCRIPT');
    evaluatePackage(store, target);
    expect(hintsForPackage(store, target.packagePath).map((h) => h.state)).toEqual(['candidate']);
    record(store, root, target.projectId, 'test:unit', 'success');
    evaluatePackage(store, target);
    const [hint] = hintsForPackage(store, target.packagePath);
    expect(hint).toMatchObject({ state: 'active', failed_script: 'test', suggested_script: 'test:unit', version: 1 });
    expect(JSON.parse(hint!.evidence_event_ids_json)).toHaveLength(2);
    const actions = (store.db.prepare('SELECT action FROM audit_events ORDER BY rowid').all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['hint.candidate', 'hint.verified', 'hint.active']);
  });

  it('works when the success is observed before the failure', () => {
    const { store, root, target } = setup({ 'test:unit': 'vitest' });
    record(store, root, target.projectId, 'test:unit', 'success');
    record(store, root, target.projectId, 'test', 'failure', 'NPM_MISSING_SCRIPT');
    evaluatePackage(store, target);
    expect(hintsForPackage(store, target.packagePath)[0]?.state).toBe('active');
  });

  it('is idempotent', () => {
    const { store, root, target } = setup({ 'test:unit': 'vitest' });
    record(store, root, target.projectId, 'test', 'failure', 'NPM_MISSING_SCRIPT');
    record(store, root, target.projectId, 'test:unit', 'success');
    evaluatePackage(store, target);
    evaluatePackage(store, target);
    expect(hintsForPackage(store, target.packagePath)).toHaveLength(1);
    expect((store.db.prepare('SELECT COUNT(*) n FROM audit_events').get() as { n: number }).n).toBe(3);
  });

  it('leaves all candidates inactive when ambiguous', () => {
    const { store, root, target } = setup({ 'test:unit': 'vitest', 'test:e2e': 'playwright' });
    record(store, root, target.projectId, 'test', 'failure', 'NPM_MISSING_SCRIPT');
    record(store, root, target.projectId, 'test:unit', 'success');
    record(store, root, target.projectId, 'test:e2e', 'success');
    evaluatePackage(store, target);
    expect(hintsForPackage(store, target.packagePath).map((h) => h.state)).toEqual(['candidate', 'candidate']);
  });

  it('never revives a disabled hint', () => {
    const { store, root, target } = setup({ 'test:unit': 'vitest' });
    record(store, root, target.projectId, 'test', 'failure', 'NPM_MISSING_SCRIPT');
    evaluatePackage(store, target);
    store.db.prepare("UPDATE hints SET state = 'disabled'").run();
    record(store, root, target.projectId, 'test:unit', 'success');
    evaluatePackage(store, target);
    expect(hintsForPackage(store, target.packagePath)[0]?.state).toBe('disabled');
  });
});
