import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeSessionStart, normalizeToolHook } from '../../src/hooks/tool-result.js';
import { parseJsonObject } from '../../src/security/sanitize.js';

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../fixtures/hooks/${name}`, import.meta.url), 'utf8'));

describe('normalizeToolHook with real-device fixtures', () => {
  it('records the Missing script failure', () => {
    expect(normalizeToolHook('PostToolUseFailure', fixture('post-tool-use-failure-missing-script.json'))).toEqual({
      kind: 'tool',
      event_type: 'PostToolUseFailure',
      session_id: '00000000-0000-4000-8000-000000000001',
      tool_use_id: 'toolu_fixture0003',
      prompt_id: '00000000-0000-4000-8000-000000000002',
      cwd: '/Users/dev/work/project-a',
      command_family: 'npm_script',
      command_name: 'test',
      outcome: 'failure',
      failure_code: 'NPM_MISSING_SCRIPT',
      duration_ms: 1349,
    });
  });

  it('records a generic non-zero exit', () => {
    const e = normalizeToolHook('PostToolUseFailure', fixture('post-tool-use-failure-exit-code.json'));
    expect(e).toMatchObject({ command_name: 'fail', outcome: 'failure', failure_code: 'EXIT_NONZERO' });
  });

  it('records the success', () => {
    const e = normalizeToolHook('PostToolUse', fixture('post-tool-use-success-test-unit.json'));
    expect(e).toMatchObject({ command_name: 'test:unit', outcome: 'success', failure_code: null, duration_ms: 197 });
  });

  it('never carries command text, output or error text', () => {
    for (const [event, name] of [
      ['PostToolUseFailure', 'post-tool-use-failure-missing-script.json'],
      ['PostToolUse', 'post-tool-use-success-test-unit.json'],
    ] as const) {
      const out = JSON.stringify(normalizeToolHook(event, fixture(name)));
      expect(out).not.toMatch(/Missing script|unit ok|description|transcript|stdout|npm run/);
    }
  });
});

describe('normalizeToolHook edge cases', () => {
  const base = {
    session_id: 's1',
    cwd: '/p',
    tool_name: 'Bash',
    tool_use_id: 't1',
    tool_input: { command: 'npm test' },
  };

  it('treats interrupts as unknown', () => {
    expect(normalizeToolHook('PostToolUseFailure', { ...base, error: 'Exit code 130', is_interrupt: true })?.outcome).toBe('unknown');
    expect(normalizeToolHook('PostToolUse', { ...base, tool_response: { interrupted: true } })?.outcome).toBe('unknown');
  });

  it('does not assume success from an unexpected response shape', () => {
    expect(normalizeToolHook('PostToolUse', { ...base, tool_response: 'ok' })?.outcome).toBe('unknown');
    expect(normalizeToolHook('PostToolUse', base)?.outcome).toBe('unknown');
    expect(normalizeToolHook('PostToolUseFailure', base)?.outcome).toBe('unknown');
  });

  it('keeps non-npm Bash commands without naming them', () => {
    const e = normalizeToolHook('PostToolUseFailure', { ...base, tool_input: { command: 'cd x && npm test' }, error: 'Exit code 1\nnpm error Missing script: "test"\n' });
    expect(e).toMatchObject({ command_family: null, command_name: null, outcome: 'failure', failure_code: 'EXIT_NONZERO' });
  });

  it('rejects unusable payloads', () => {
    expect(normalizeToolHook('PostToolUse', { ...base, tool_name: 'Read' })).toBeNull();
    expect(normalizeToolHook('PreToolUse', base)).toBeNull();
    expect(normalizeToolHook('PostToolUse', { ...base, session_id: '../../etc' })).toBeNull();
    expect(normalizeToolHook('PostToolUse', { ...base, cwd: 'relative' })).toBeNull();
    expect(normalizeToolHook('PostToolUse', {})).toBeNull();
  });

  it('drops invalid optional fields and ignores unknown ones', () => {
    const e = normalizeToolHook('PostToolUse', { ...base, tool_use_id: 'bad id!', prompt_id: 5, duration_ms: -1, extra: { deep: true }, tool_response: { interrupted: false } });
    expect(e).toMatchObject({ tool_use_id: null, prompt_id: null, duration_ms: null, outcome: 'success' });
    expect(e).not.toHaveProperty('extra');
  });
});

describe('normalizeSessionStart', () => {
  it('reads the fixture', () => {
    expect(normalizeSessionStart(fixture('session-start.json'))).toEqual({
      kind: 'session_start',
      session_id: '00000000-0000-4000-8000-000000000001',
      cwd: '/Users/dev/work/project-a',
      source: 'startup',
    });
  });

  it('tolerates unknown sources and rejects missing ids', () => {
    expect(normalizeSessionStart({ session_id: 's', cwd: '/p', source: 'new-kind' })?.source).toBeNull();
    expect(normalizeSessionStart({ cwd: '/p' })).toBeNull();
  });
});

describe('parseJsonObject', () => {
  it('enforces size and shape', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('[1]')).toBeNull();
    expect(parseJsonObject('nope')).toBeNull();
    expect(parseJsonObject('')).toBeNull();
    expect(parseJsonObject(`{"a":"${'x'.repeat(300 * 1024)}"}`)).toBeNull();
  });
});
