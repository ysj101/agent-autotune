import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveProjectRoot } from '../../src/project/detect.js';
import { findPackageJson, readPackageJson } from '../../src/project/package-json.js';
import { isWithin, safeRealpath } from '../../src/security/path-guard.js';
import { tmpDir } from '../helpers/tmp.js';

function project(pkg: unknown = { scripts: { 'test:unit': 'vitest' } }): string {
  const root = realpathSync(tmpDir('aat-proj-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  return root;
}

describe('path guard', () => {
  it('checks containment', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c')).toBe(true);
    expect(isWithin('/a/b', '/a/bc')).toBe(false);
    expect(isWithin('/a/b', '/a')).toBe(false);
    expect(isWithin('/a/b', '/a/b/../c')).toBe(false);
  });

  it('rejects relative, NUL and missing paths', () => {
    expect(safeRealpath('rel/path')).toBeNull();
    expect(safeRealpath('/tmp/\0x')).toBeNull();
    expect(safeRealpath('/definitely/not/here')).toBeNull();
    expect(safeRealpath(undefined)).toBeNull();
  });
});

describe('resolveProjectRoot', () => {
  it('finds the git root from a subdirectory', () => {
    const root = project();
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    expect(resolveProjectRoot(join(root, 'src', 'deep'))).toBe(root);
  });

  it('falls back to cwd without git, and rejects bad input', () => {
    const dir = realpathSync(tmpDir());
    expect(resolveProjectRoot(dir)).toBe(dir);
    expect(resolveProjectRoot('relative')).toBeNull();
    expect(resolveProjectRoot(join(dir, 'missing'))).toBeNull();
    writeFileSync(join(dir, 'f'), '');
    expect(resolveProjectRoot(join(dir, 'f'))).toBeNull();
  });
});

describe('package.json', () => {
  it('reads safe script names and hashes content', () => {
    const root = project({ scripts: { 'test:unit': 'vitest', 'bad name': 'x', build: 42 } });
    const r = findPackageJson(root, root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.pkg.scripts]).toEqual(['test:unit']);
    expect(r.pkg.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.pkg.path).toBe(join(root, 'package.json'));
  });

  it('changes hash when content changes', () => {
    const root = project();
    const a = readPackageJson(join(root, 'package.json'), root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'jest' } }));
    const b = readPackageJson(join(root, 'package.json'), root);
    expect(a.ok && b.ok && a.pkg.hash !== b.pkg.hash).toBe(true);
  });

  it('resolves the nearest workspace package', () => {
    const root = project({ scripts: { test: 'x' } });
    const ws = join(root, 'packages', 'a');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'x' } }));
    const r = findPackageJson(join(ws, 'src'), root);
    expect(r.ok && r.pkg.path).toBe(join(ws, 'package.json'));
    const top = findPackageJson(join(root, 'packages'), root);
    expect(top.ok && top.pkg.path).toBe(join(root, 'package.json'));
  });

  it.each([
    ['broken JSON', '{"scripts": {', 'invalid_json'],
    ['array', '[]', 'invalid_shape'],
    ['scripts not object', '{"scripts": "x"}', 'invalid_shape'],
  ])('rejects %s', (_l, content, reason) => {
    const root = project(content);
    expect(findPackageJson(root, root)).toEqual({ ok: false, reason });
  });

  it('rejects files that are too large', () => {
    const root = project(`{"x":"${'a'.repeat(1024 * 1024)}"}`);
    expect(findPackageJson(root, root)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('accepts a package without scripts', () => {
    const root = project({ name: 'x' });
    const r = findPackageJson(root, root);
    expect(r.ok && r.pkg.scripts.size).toBe(0);
  });

  it('does not walk above the project root', () => {
    const outer = realpathSync(tmpDir());
    writeFileSync(join(outer, 'package.json'), '{}');
    const root = join(outer, 'repo');
    mkdirSync(join(root, '.git'), { recursive: true });
    expect(findPackageJson(root, root)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects a symlinked package.json that escapes the root', () => {
    const outside = realpathSync(tmpDir());
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'x' } }));
    const root = realpathSync(tmpDir());
    symlinkSync(join(outside, 'package.json'), join(root, 'package.json'));
    expect(findPackageJson(root, root)).toEqual({ ok: false, reason: 'outside_root' });
  });

  it('rejects a cwd outside the root (including via symlinked dir)', () => {
    const root = project();
    const outside = realpathSync(tmpDir());
    symlinkSync(outside, join(root, 'link'));
    expect(findPackageJson(join(root, 'link'), root)).toEqual({ ok: false, reason: 'outside_root' });
    expect(findPackageJson(outside, root)).toEqual({ ok: false, reason: 'outside_root' });
  });

  it('rejects a directory named package.json', () => {
    const root = realpathSync(tmpDir());
    mkdirSync(join(root, 'package.json'));
    expect(findPackageJson(root, root)).toEqual({ ok: false, reason: 'not_a_file' });
  });
});
