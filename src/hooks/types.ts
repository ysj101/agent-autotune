import type { FailureCode } from '../rules/npm-errors.js';

export type Outcome = 'success' | 'failure' | 'unknown';

export const TOOL_HOOK_EVENTS = ['PostToolUse', 'PostToolUseFailure'] as const;
export type ToolHookEvent = (typeof TOOL_HOOK_EVENTS)[number];

export const SESSION_SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork'] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

/** Allowlisted, classified view of a Bash tool hook. Never carries command text or output. */
export interface HookToolEvent {
  kind: 'tool';
  event_type: ToolHookEvent;
  session_id: string;
  tool_use_id: string | null;
  prompt_id: string | null;
  cwd: string;
  command_family: string | null;
  command_name: string | null;
  outcome: Outcome;
  failure_code: FailureCode | null;
  duration_ms: number | null;
}

export interface HookSessionStart {
  kind: 'session_start';
  session_id: string;
  cwd: string;
  source: SessionSource | null;
}
