import { describe, expect, it } from 'vitest';
import { isSafeScriptName, npmCommandFor, parseNpmCommand } from '../../src/rules/npm-command.js';

describe('parseNpmCommand', () => {
  it.each([
    ['npm test', 'test'],
    ['npm run test', 'test'],
    ['npm run test:unit', 'test:unit'],
    ['  npm   run   build.prod  ', 'build.prod'],
    ['npm\trun\tlint-fix', 'lint-fix'],
    ['npm run e2e_ci', 'e2e_ci'],
  ])('accepts %j', (cmd, name) => {
    expect(parseNpmCommand(cmd)).toEqual({ family: 'npm_script', name });
  });

  it.each([
    'npm test && rm -rf /',
    'cd x && npm test',
    'npm test; echo hi',
    'npm test | tee out',
    'npm test > out.txt',
    'npm test 2>&1',
    'npm run "test:unit"',
    "npm run 'test'",
    'npm run $SCRIPT',
    'npm run ${SCRIPT}',
    'npm run `whoami`',
    'npm run $(whoami)',
    'npm run test*',
    'npm run te?t',
    'npm test\nrm -rf /',
    'npm run test\\:unit',
    'npm test -- --watch',
    'npm run test --silent',
    'npm run -s test',
    'npm run',
    'npm run --',
    'npm run -test',
    'npm',
    'npx vitest',
    'pnpm test',
    'yarn test',
    'npm install',
    'npm t',
    'npm run-script test',
    'FOO=1 npm test',
    'sudo npm test',
    'npm test &',
    '',
    `npm run ${'a'.repeat(70)}`,
    `npm run ${'a'.repeat(300)}`,
  ])('rejects %j', (cmd) => {
    expect(parseNpmCommand(cmd)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseNpmCommand(undefined)).toBeNull();
    expect(parseNpmCommand(42)).toBeNull();
    expect(parseNpmCommand({ command: 'npm test' })).toBeNull();
  });
});

describe('script names', () => {
  it('validates safe names', () => {
    expect(isSafeScriptName('test:unit')).toBe(true);
    expect(isSafeScriptName('-x')).toBe(false);
    expect(isSafeScriptName('a b')).toBe(false);
    expect(isSafeScriptName('ｔest')).toBe(false);
  });

  it('formats the command to mention', () => {
    expect(npmCommandFor('test')).toBe('npm test');
    expect(npmCommandFor('test:unit')).toBe('npm run test:unit');
  });
});
