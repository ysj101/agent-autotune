import type { PackageInfo } from '../project/package-json.js';
import type { Execution } from '../telemetry/correlation.js';

/**
 * R001: npm missing-script correction (pure evaluation, no I/O).
 *
 * A script F is "missing" when an `npm test` / `npm run F` failed as NPM_MISSING_SCRIPT (or failed
 * while F is absent from the current package.json). Related scripts are those in the current
 * package.json that share F's family by name (`F:x`, `F-x`, `F_x`, `F.x`, or a small alias list).
 * Name similarity alone never verifies a candidate: it also needs an observed successful
 * `npm run <candidate>` in the same package. Only a single verified candidate may be applied.
 */

export const RULE_ID = 'R001';

const ALIASES: Record<string, readonly string[]> = {
  test: ['tests', 'spec', 'unit'],
};

const MAX_EVIDENCE = 20;

export interface CandidateEvaluation {
  script: string;
  successIds: string[];
}

export interface R001Proposal {
  failedScript: string;
  failureIds: string[];
  candidates: CandidateEvaluation[];
  /** The one candidate that may become active, or null if there are none or several. */
  verified: string | null;
}

export function isRelatedScript(failed: string, candidate: string): boolean {
  if (candidate === failed) return false;
  if ([':', '-', '_', '.'].some((sep) => candidate.startsWith(failed + sep))) return true;
  return ALIASES[failed]?.includes(candidate) ?? false;
}

export function evaluateR001(pkg: PackageInfo, executions: Execution[]): R001Proposal[] {
  const failures = new Map<string, string[]>();
  for (const e of executions) {
    if (e.outcome !== 'failure' || pkg.scripts.has(e.command_name)) continue;
    if (e.failure_code !== 'NPM_MISSING_SCRIPT' && e.failure_code !== 'EXIT_NONZERO') continue;
    failures.set(e.command_name, [...(failures.get(e.command_name) ?? []), e.id]);
  }
  const proposals: R001Proposal[] = [];
  for (const [failedScript, failureIds] of failures) {
    const candidates = [...pkg.scripts]
      .filter((s) => isRelatedScript(failedScript, s))
      .sort()
      .map((script) => ({
        script,
        successIds: executions.filter((e) => e.command_name === script && e.outcome === 'success').map((e) => e.id),
      }));
    if (candidates.length === 0) continue;
    const succeeded = candidates.filter((c) => c.successIds.length > 0);
    proposals.push({
      failedScript,
      failureIds: failureIds.slice(-MAX_EVIDENCE),
      candidates,
      verified: succeeded.length === 1 ? succeeded[0]!.script : null,
    });
  }
  return proposals;
}

export function evidenceFor(p: R001Proposal, script: string): string[] {
  const successIds = p.candidates.find((c) => c.script === script)?.successIds ?? [];
  return [...p.failureIds, ...successIds.slice(-MAX_EVIDENCE)];
}
