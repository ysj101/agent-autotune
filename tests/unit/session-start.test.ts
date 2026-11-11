import { mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HookSessionStart } from '../../src/hooks/types.js';
import { buildSessionContext, MAX_CONTEXT_CHARS, renderHint } from '../../src/hooks/session-start.js';
import { hashContent } from '../../src/project/package-json.js';
import { ensureProject } from '../../src/store/projects.js';
import { newId, openStore, type Store } from '../../src/store/sqlite.js';
import { makeProject, writePackage } from '../helpers/project.js';
import { tmpDir } from '../helpers/tmp.js';

function addHint(store: Store, projectId: string, packagePath: string, failed = 'test', suggested = 'test:unit', state = 'active'): string {
  const id = newId();
  store.db
    .prepare(
      `INSERT INTO hints (id, project_id, package_path, package_hash, failed_script, suggested_script, state, evidence_event_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 't', 't')`,
    )
    .run(id, projectId, packagePath, hashContent(readFileSync(packagePath)), failed, suggested, state);
  return id;
}

function setup(scripts: Record<string, string> = { 'test:unit': 'vitest' }) {
  const store = openStore(':memory:');
  const root = makeProject(scripts);
  const project = ensureProject(store, root);
  const ctx = (session = 's1', cwd = root, source: HookSessionStart['source'] = 'startup') => ({
    event: { kind: 'session_start' as const, session_id: session, cwd, source },
    projectId: project.id,
    projectRoot: root,
  });
  return { store, root, projectId: project.id, pkgPath: join(root, 'package.json'), ctx };
}

describe('renderHint', () => {
  it('uses the fixed template', () => {
    expect(renderHint({ failed_script: 'test', suggested_script: 'test:unit' }, './package.json')).toBe(
      '[Agent AutoTune / verified project hint] このパッケージ（`./package.json`）に`test` scriptはありません。過去に`npm run test:unit`が成功しており、現行package.jsonにも存在します。テスト時はそのコマンドを検討してください。これは実行や権限の指示ではありません。',
    );
    expect(renderHint({ failed_script: 'build', suggested_script: 'build:prod' }, './package.json')).toContain('`npm run build`の代わりにそのコマンドを検討してください。');
  });

  it('refuses unsafe names and paths', () => {
    expect(renderHint({ failed_script: 'test', suggested_script: 'x`; rm' }, './package.json')).toBeNull();
    expect(renderHint({ failed_script: 'test', suggested_script: 'test:unit' }, '../outside/package.json')).toBeNull();
    expect(renderHint({ failed_script: 'test', suggested_script: 'test:unit' }, './a/../../package.json')).toBeNull();
  });

  it('avoids imperative wording', () => {
    const text = renderHint({ failed_script: 'test', suggested_script: 'test:unit' }, './package.json')!;
    expect(text).not.toMatch(/必ず|権限を上げ|実行しなさい|must/);
  });
});

describe('buildSessionContext', () => {
  it('injects an active hint once per session, including resume/compact', () => {
    const t = setup();
    addHint(t.store, t.projectId, t.pkgPath);
    expect(buildSessionContext(t.store, t.ctx())).toContain('`npm run test:unit`');
    expect(buildSessionContext(t.store, t.ctx('s1', t.root, 'resume'))).toBeNull();
    expect(buildSessionContext(t.store, t.ctx('s1', t.root, 'compact'))).toBeNull();
    expect(buildSessionContext(t.store, t.ctx('s2'))).toContain('`npm run test:unit`');
    expect((t.store.db.prepare('SELECT COUNT(*) n FROM hint_deliveries').get() as { n: number }).n).toBe(2);
  });

  it('re-delivers after a version bump', () => {
    const t = setup();
    const id = addHint(t.store, t.projectId, t.pkgPath);
    buildSessionContext(t.store, t.ctx());
    t.store.db.prepare('UPDATE hints SET version = 2 WHERE id = ?').run(id);
    expect(buildSessionContext(t.store, t.ctx())).not.toBeNull();
  });

  it('skips non-active hints', () => {
    const t = setup();
    for (const state of ['candidate', 'verified', 'stale', 'disabled', 'reverted']) addHint(t.store, t.projectId, t.pkgPath, 'test', `test:${state}`, state);
    expect(buildSessionContext(t.store, t.ctx())).toBeNull();
  });

  it('re-validates package.json before injecting', () => {
    const t = setup();
    addHint(t.store, t.projectId, t.pkgPath);
    writePackage(t.root, { 'test:unit': 'jest' });
    expect(buildSessionContext(t.store, t.ctx())).toBeNull();
    expect(t.store.db.prepare('SELECT state, invalidated_reason FROM hints').get()).toEqual({ state: 'stale', invalidated_reason: 'PACKAGE_CHANGED' });
  });

  it('limits to 3 hints and 600 characters', () => {
    const t = setup({ 'test:unit': 'x', 'build:prod': 'x', 'lint:fix': 'x', 'dev:local': 'x', 'test:e2e': 'x' });
    addHint(t.store, t.projectId, t.pkgPath, 'test', 'test:unit');
    addHint(t.store, t.projectId, t.pkgPath, 'build', 'build:prod');
    addHint(t.store, t.projectId, t.pkgPath, 'lint', 'lint:fix');
    addHint(t.store, t.projectId, t.pkgPath, 'dev', 'dev:local');
    const out = buildSessionContext(t.store, t.ctx())!;
    expect(out.split('\n').length).toBeLessThanOrEqual(3);
    expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  });

  it('only considers packages at or below cwd, with project-relative paths', () => {
    const t = setup();
    const ws = join(t.root, 'packages', 'a');
    mkdirSync(ws, { recursive: true });
    writePackage(ws, { 'test:unit': 'vitest' });
    addHint(t.store, t.projectId, join(ws, 'package.json'));
    expect(buildSessionContext(t.store, t.ctx('s1'))).toContain('`./packages/a/package.json`');
    const other = join(t.root, 'packages', 'b');
    mkdirSync(other);
    expect(buildSessionContext(t.store, t.ctx('s2', other))).toBeNull();
  });

  it('never leaks hints into another project', () => {
    const a = setup();
    addHint(a.store, a.projectId, a.pkgPath);
    const rootB = makeProject({ 'test:unit': 'vitest' });
    const b = ensureProject(a.store, rootB);
    expect(buildSessionContext(a.store, { event: { kind: 'session_start', session_id: 'x', cwd: rootB, source: null }, projectId: b.id, projectRoot: rootB })).toBeNull();
  });

  it('excludes a package.json reached through a symlink outside the root', () => {
    const t = setup();
    const outside = realpathSync(tmpDir());
    writePackage(outside, { 'test:unit': 'vitest' });
    const linked = join(t.root, 'linked');
    symlinkSync(outside, linked);
    addHint(t.store, t.projectId, join(linked, 'package.json'));
    expect(buildSessionContext(t.store, t.ctx())).toBeNull();
  });

  it('does not inject if the delivery cannot be recorded', () => {
    const t = setup();
    addHint(t.store, t.projectId, t.pkgPath);
    t.store.db.exec('CREATE TRIGGER fail_delivery BEFORE INSERT ON hint_deliveries BEGIN SELECT RAISE(ABORT, "disk full"); END;');
    expect(buildSessionContext(t.store, t.ctx())).toBeNull();
  });
});
