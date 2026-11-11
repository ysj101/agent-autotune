import { parseNpmCommand } from '../rules/npm-command.js';
import { classifyNpmFailure, exitCode } from '../rules/npm-errors.js';
import { asAbsolutePath, asDurationMs, asId, asObject } from '../security/sanitize.js';
import { SESSION_SOURCES, TOOL_HOOK_EVENTS, type HookSessionStart, type HookToolEvent, type Outcome, type SessionSource, type ToolHookEvent } from './types.js';

/**
 * Outcome as observed on Claude Code 2.1.310 (docs/findings-real-device.md):
 * - a non-zero exit arrives as PostToolUseFailure with `error: "Exit code N\n..."`;
 * - a normal exit arrives as PostToolUse with `tool_response.interrupted === false`.
 * Anything else (interrupts, unexpected shapes) is `unknown`, never success.
 */
function outcomeOf(event: ToolHookEvent, input: Record<string, unknown>): Outcome {
  if (event === 'PostToolUse') {
    const response = asObject(input['tool_response']);
    return response?.['interrupted'] === false ? 'success' : 'unknown';
  }
  if (input['is_interrupt'] === true) return 'unknown';
  return typeof input['error'] === 'string' ? 'failure' : 'unknown';
}

/** Reduce a PostToolUse / PostToolUseFailure payload to allowlisted fields. Returns null if unusable. */
export function normalizeToolHook(eventName: string, input: Record<string, unknown>): HookToolEvent | null {
  if (!(TOOL_HOOK_EVENTS as readonly string[]).includes(eventName)) return null;
  const event = eventName as ToolHookEvent;
  if (input['tool_name'] !== 'Bash') return null;
  const sessionId = asId(input['session_id']);
  const cwd = asAbsolutePath(input['cwd']);
  if (!sessionId || !cwd) return null;

  const command = parseNpmCommand(asObject(input['tool_input'])?.['command']);
  const outcome = outcomeOf(event, input);
  let failureCode: HookToolEvent['failure_code'] = null;
  if (outcome === 'failure') {
    const error = input['error'];
    if (command) failureCode = classifyNpmFailure(error, command.name);
    else failureCode = (exitCode(error) ?? 0) !== 0 ? 'EXIT_NONZERO' : null;
  }

  return {
    kind: 'tool',
    event_type: event,
    session_id: sessionId,
    tool_use_id: asId(input['tool_use_id']),
    prompt_id: asId(input['prompt_id']),
    cwd,
    command_family: command?.family ?? null,
    command_name: command?.name ?? null,
    outcome,
    failure_code: failureCode,
    duration_ms: asDurationMs(input['duration_ms']),
  };
}

export function normalizeSessionStart(input: Record<string, unknown>): HookSessionStart | null {
  const sessionId = asId(input['session_id']);
  const cwd = asAbsolutePath(input['cwd']);
  if (!sessionId || !cwd) return null;
  const source = input['source'];
  return {
    kind: 'session_start',
    session_id: sessionId,
    cwd,
    source: (SESSION_SOURCES as readonly unknown[]).includes(source) ? (source as SessionSource) : null,
  };
}
