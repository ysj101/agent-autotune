import { FAILURE_CODES } from '../rules/npm-errors.js';
import { isSafeScriptName, NPM_SCRIPT_FAMILY } from '../rules/npm-command.js';
import { asAbsolutePath, asDurationMs, asId } from '../security/sanitize.js';
import { SESSION_SOURCES, TOOL_HOOK_EVENTS, type HookSessionStart, type HookToolEvent, type Outcome } from './types.js';

/**
 * The daemon re-validates what the hook process sends: anything on the loopback port that knows
 * the token is still treated as untrusted input.
 */

const OUTCOMES: readonly Outcome[] = ['success', 'failure', 'unknown'];

function nullable<T>(v: unknown, parse: (x: unknown) => T | null): T | null | undefined {
  if (v === null) return null;
  const parsed = parse(v);
  return parsed === null ? undefined : parsed;
}

export function validateHookToolEvent(o: Record<string, unknown>): HookToolEvent | null {
  if (o['kind'] !== 'tool') return null;
  const eventType = o['event_type'];
  if (!(TOOL_HOOK_EVENTS as readonly unknown[]).includes(eventType)) return null;
  const sessionId = asId(o['session_id']);
  const cwd = asAbsolutePath(o['cwd']);
  const outcome = o['outcome'];
  if (!sessionId || !cwd || !(OUTCOMES as readonly unknown[]).includes(outcome)) return null;
  const toolUseId = nullable(o['tool_use_id'], asId);
  const promptId = nullable(o['prompt_id'], asId);
  const duration = nullable(o['duration_ms'], asDurationMs);
  const family = nullable(o['command_family'], (v) => (v === NPM_SCRIPT_FAMILY ? NPM_SCRIPT_FAMILY : null));
  const name = nullable(o['command_name'], (v) => (typeof v === 'string' && isSafeScriptName(v) ? v : null));
  const failure = nullable(o['failure_code'], (v) => ((FAILURE_CODES as readonly unknown[]).includes(v) ? (v as HookToolEvent['failure_code']) : null));
  if ([toolUseId, promptId, duration, family, name, failure].includes(undefined)) return null;
  if ((family === null) !== (name === null)) return null;
  return {
    kind: 'tool',
    event_type: eventType as HookToolEvent['event_type'],
    session_id: sessionId,
    tool_use_id: toolUseId!,
    prompt_id: promptId!,
    cwd,
    command_family: family!,
    command_name: name!,
    outcome: outcome as Outcome,
    failure_code: failure!,
    duration_ms: duration!,
  };
}

export function validateHookSessionStart(o: Record<string, unknown>): HookSessionStart | null {
  if (o['kind'] !== 'session_start') return null;
  const sessionId = asId(o['session_id']);
  const cwd = asAbsolutePath(o['cwd']);
  if (!sessionId || !cwd) return null;
  const source = o['source'];
  if (source !== null && !(SESSION_SOURCES as readonly unknown[]).includes(source)) return null;
  return { kind: 'session_start', session_id: sessionId, cwd, source: source as HookSessionStart['source'] };
}
