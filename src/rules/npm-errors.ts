/**
 * Classify a failed Bash tool result into a coarse failure code. Only the code is kept;
 * the error text itself is never stored.
 */

export const FAILURE_CODES = ['NPM_MISSING_SCRIPT', 'EXIT_NONZERO'] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Only the head of the error is inspected; npm prints the message on its first lines. */
const SCAN_LIMIT = 4096;

// npm >= 7: `npm ERR! Missing script: "test"`; npm >= 10: `npm error Missing script: "test"`.
const QUOTED = /(?:^|\n)[ \t]*npm (?:ERR!|error) Missing script: "([^"\n]{1,64})"/;
// npm 6: `npm ERR! missing script: test` (unquoted). Require the line to end so a truncated
// name is never accepted.
const UNQUOTED = /(?:^|\n)[ \t]*npm ERR! missing script: ([A-Za-z0-9:._-]{1,64})[ \t]*\r?\n/;
const EXIT_CODE = /^Exit code (\d{1,3})\b/;

/** Script name npm reported as missing, or null if the text is not (or not fully) such an error. */
export function missingScriptName(errorText: unknown): string | null {
  if (typeof errorText !== 'string') return null;
  const head = errorText.slice(0, SCAN_LIMIT);
  return QUOTED.exec(head)?.[1] ?? UNQUOTED.exec(head)?.[1] ?? null;
}

export function exitCode(errorText: unknown): number | null {
  if (typeof errorText !== 'string') return null;
  const m = EXIT_CODE.exec(errorText);
  return m ? Number(m[1]) : null;
}

/**
 * @param expectedScript the script the command tried to run. A Missing script message about a
 *   different script is not trusted as evidence for this one.
 */
export function classifyNpmFailure(errorText: unknown, expectedScript: string): FailureCode | null {
  const missing = missingScriptName(errorText);
  if (missing !== null) return missing === expectedScript ? 'NPM_MISSING_SCRIPT' : null;
  const code = exitCode(errorText);
  return code !== null && code !== 0 ? 'EXIT_NONZERO' : null;
}
