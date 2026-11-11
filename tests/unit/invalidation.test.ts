import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HookToolEvent } from '../../src/hooks/types.js';
import { readPackageJson } from '../../src/project/package-json.js';
import { evaluatePackage, hintsForPackage, revalidateForInjection } from '../../src/rules/engine.js';
import { ensureProject } from '../../src/store/projects.js';
import { openStore, type Store } from '../../src/store/sqlite.js';
import { recordHookToolEvent, recordOtelToolResult } from '../../src/telemetry/correlation.js';
import { makeProject, writePackage } from '../helpers/project.js';

let n = 0;

function setup(scripts: Record<string, string> = { 'test:unit': 'vitest' }) {
  const store = openStore(':memory:');
  const root = makeProject(scripts);
  const project = ensureProject(store, root);
  const target = { projectId: project.id, projectRoot: root, packagePath: join(root, 'package.json') };
  const record = (name: string, outcome: HookToolEvent['outcome'], failure: HookToolEvent['failure_code'] = null): string => {
    const read = readPackageJson(target.packagePath, root);
    const id = `t${++n}`;
    recordHookToolEvent(
      store,
      { kind: 'tool', event_type: outcome === 'success' ? 'PostToolUse' : 'PostToolUseFailure', session_id: 's', tool_use_id: id, prompt_id: null, cwd: root, command_family: 'npm_script', command_name: name, outcome, failure_code: failure, duration_ms: null },
      { projectId: project.id, packagePath: target.packagePath, packageHash: read.ok ? read.pkg.hash : null },
    );
    return id;
  };
  const activate = (): string => {
    record('test', 'failure', 'NPM_MISSING_SCRIPT');
    const successToolUseId = record('test:unit', 'success');
    evaluatePackage(store, target);
    expect(state()).toBe('active');
    return successToolUseId;
  };
  const hint = () => hintsForPackage(store, target.packagePath).find((h) => h.suggested_script === 'test:unit')!;
  const state = (): string => hint().state;
  return { store, root, target, record, activate, hint, state };
}

const reason = (store: Store): string | null =>
  (store.db.prepare("SELECT invalidated_reason r FROM hints WHERE suggested_script = 'test:unit' ORDER BY created_at").get() as { r: string | null }).r;

describe('automatic invalidation', () => {
  it('marks the hint stale when package.json changes', () => {
    const t = setup();
    t.activate();
    writePackage(t.root, { 'test:unit': 'vitest', lint: 'eslint' });
    evaluatePackage(t.store, t.target);
    expect(t.state()).toBe('stale');
    expect(reason(t.store)).toBe('PACKAGE_CHANGED');
  });

  it('distinguishes a removed suggested script and an added failed script', () => {
    const a = setup();
    a.activate();
    writePackage(a.root, { build: 'tsc' });
    evaluatePackage(a.store, a.target);
    expect(reason(a.store)).toBe('SCRIPT_REMOVED');

    const b = setup();
    b.activate();
    writePackage(b.root, { test: 'vitest', 'test:unit': 'vitest' });
    evaluatePackage(b.store, b.target);
    expect(reason(b.store)).toBe('FAILED_SCRIPT_ADDED');
  });

  it('marks the hint stale when package.json is deleted or broken', () => {
    const a = setup();
    a.activate();
    rmSync(a.target.packagePath);
    evaluatePackage(a.store, a.target);
    expect([a.state(), reason(a.store)]).toEqual(['stale', 'PACKAGE_DELETED']);

    const b = setup();
    b.activate();
    writeFileSync(b.target.packagePath, '{ broken');
    evaluatePackage(b.store, b.target);
    expect([b.state(), reason(b.store)]).toEqual(['stale', 'PACKAGE_UNREADABLE']);
  });

  it('reverts when another candidate also succeeds', () => {
    const t = setup({ 'test:unit': 'vitest', 'test:e2e': 'playwright' });
    t.activate();
    t.record('test:e2e', 'success');
    evaluatePackage(t.store, t.target);
    expect([t.state(), reason(t.store)]).toEqual(['reverted', 'MULTIPLE_CANDIDATES']);
  });

  it('disables when the suggested script is itself reported missing', () => {
    const t = setup();
    t.activate();
    t.record('test:unit', 'failure', 'NPM_MISSING_SCRIPT');
    evaluatePackage(t.store, t.target);
    expect([t.state(), reason(t.store)]).toEqual(['disabled', 'CONTRADICTORY_OBSERVATION']);
  });

  it('disables when the verifying success is contradicted by OTel', () => {
    const t = setup();
    const toolUseId = t.activate();
    recordOtelToolResult(t.store, { session_id: 's', tool_use_id: toolUseId, prompt_id: null, event_sequence: 1, tool_name: 'Bash', outcome: 'failure', duration_ms: 1, observed_at: '2026-11-11T00:00:00.000Z' });
    evaluatePackage(t.store, t.target);
    expect([t.state(), reason(t.store)]).toEqual(['disabled', 'CONTRADICTORY_OBSERVATION']);
  });

  it('creates a fresh hint for the new package.json when the evidence still holds', () => {
    const t = setup();
    t.activate();
    writePackage(t.root, { 'test:unit': 'vitest', lint: 'eslint' });
    t.record('test:unit', 'success');
    evaluatePackage(t.store, t.target);
    expect(hintsForPackage(t.store, t.target.packagePath).map((h) => h.state)).toEqual(['stale', 'active']);
  });

  it('keeps an unchanged hint active', () => {
    const t = setup();
    t.activate();
    t.record('test:unit', 'success');
    evaluatePackage(t.store, t.target);
    expect(t.state()).toBe('active');
  });
});

describe('revalidateForInjection', () => {
  it('passes an unchanged hint and stops a changed one immediately', () => {
    const t = setup();
    t.activate();
    expect(revalidateForInjection(t.store, t.hint(), t.root)).toBe(true);
    writePackage(t.root, { 'test:unit': 'jest' });
    expect(revalidateForInjection(t.store, t.hint(), t.root)).toBe(false);
    expect(t.state()).toBe('stale');
    expect(revalidateForInjection(t.store, t.hint(), t.root)).toBe(false);
  });
});
