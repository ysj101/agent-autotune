import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyNpmFailure, exitCode, missingScriptName } from '../../src/rules/npm-errors.js';

const fixture = (name: string): { error: string } =>
  JSON.parse(readFileSync(new URL(`../fixtures/hooks/${name}`, import.meta.url), 'utf8'));

describe('missingScriptName', () => {
  it.each([
    ['npm 10', 'Exit code 1\nnpm error Missing script: "test"\nnpm error\n', 'test'],
    ['npm 7-9', 'Exit code 1\nnpm ERR! Missing script: "test:unit"\nnpm ERR! \n', 'test:unit'],
    ['npm 6', 'Exit code 1\nnpm ERR! missing script: lint\n\nnpm ERR! A complete log', 'lint'],
    ['indented', '  npm error Missing script: "build"', 'build'],
  ])('recognizes %s', (_label, text, name) => {
    expect(missingScriptName(text)).toBe(name);
  });

  it.each([
    ['truncated quoted', 'Exit code 1\nnpm error Missing script: "te'],
    ['truncated unquoted', 'Exit code 1\nnpm ERR! missing script: te'],
    ['truncated prefix', 'Exit code 1\nnpm error Missing scr'],
    ['not at line start', 'echo npm error Missing script: "test"'],
    ['other error', 'Exit code 1\nnpm error code ENOENT\n'],
    ['empty', ''],
    ['non-string', 42],
  ])('ignores %s', (_label, text) => {
    expect(missingScriptName(text)).toBeNull();
  });

  it('only scans the head of huge outputs', () => {
    expect(missingScriptName(`${'x'.repeat(10_000)}\nnpm error Missing script: "test"\n`)).toBeNull();
  });
});

describe('classifyNpmFailure', () => {
  it('classifies the real-device fixture', () => {
    expect(classifyNpmFailure(fixture('post-tool-use-failure-missing-script.json').error, 'test')).toBe('NPM_MISSING_SCRIPT');
    expect(classifyNpmFailure(fixture('post-tool-use-failure-exit-code.json').error, 'fail')).toBe('EXIT_NONZERO');
  });

  it('does not trust a message about a different script', () => {
    expect(classifyNpmFailure('Exit code 1\nnpm error Missing script: "test"\n', 'test:unit')).toBeNull();
  });

  it('returns null when nothing is recognizable', () => {
    expect(classifyNpmFailure('something odd', 'test')).toBeNull();
    expect(classifyNpmFailure(undefined, 'test')).toBeNull();
    expect(exitCode('Exit code 0')).toBe(0);
    expect(classifyNpmFailure('Exit code 0', 'test')).toBeNull();
  });
});
