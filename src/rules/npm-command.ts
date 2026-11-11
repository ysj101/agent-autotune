/**
 * Strict recognizer for the only commands R001 learns from: `npm test` and `npm run <script>`.
 *
 * No shell is involved. Anything outside a tiny character allowlist (quotes, `$`, `&`, `|`, `;`,
 * `>`, `<`, backticks, globs, newlines, backslashes, ...) is rejected outright, so compound
 * commands, redirections and expansions can never be misread as a plain npm invocation.
 */

export const NPM_SCRIPT_FAMILY = 'npm_script';

export interface NpmScriptCommand {
  family: typeof NPM_SCRIPT_FAMILY;
  /** Script name, e.g. `test` or `test:unit`. `npm test` is reported as `test`. */
  name: string;
}

const MAX_COMMAND_LENGTH = 200;
const ALLOWED_CHARS = /^[A-Za-z0-9:._\- \t]+$/;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;

/** Whether a script name is safe to store and to show back in a hint. */
export function isSafeScriptName(name: string): boolean {
  return SCRIPT_NAME.test(name);
}

export function parseNpmCommand(command: unknown): NpmScriptCommand | null {
  if (typeof command !== 'string' || command.length === 0 || command.length > MAX_COMMAND_LENGTH) return null;
  if (!ALLOWED_CHARS.test(command)) return null;
  const tokens = command.trim().split(/[ \t]+/);
  if (tokens[0] !== 'npm') return null;
  if (tokens.length === 2 && tokens[1] === 'test') return { family: NPM_SCRIPT_FAMILY, name: 'test' };
  if (tokens.length === 3 && tokens[1] === 'run' && isSafeScriptName(tokens[2]!)) {
    return { family: NPM_SCRIPT_FAMILY, name: tokens[2]! };
  }
  return null;
}

/** The command a hint should mention for a script name. */
export function npmCommandFor(name: string): string {
  return name === 'test' ? 'npm test' : `npm run ${name}`;
}
