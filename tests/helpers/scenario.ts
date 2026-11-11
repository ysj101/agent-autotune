import { join } from 'node:path';
import type { HookToolEvent } from '../../src/hooks/types.js';
import { readPackageJson } from '../../src/project/package-json.js';
import { evaluatePackage } from '../../src/rules/engine.js';
import { ensureProject, touchSession } from '../../src/store/projects.js';
import type { Store } from '../../src/store/sqlite.js';
import { recordHookToolEvent } from '../../src/telemetry/correlation.js';
import { makeProject } from './project.js';

let seq = 0;

/** A project registered in the store, with a helper to record npm runs the way the daemon does. */
export function scenario(store: Store, scripts: Record<string, string> = { 'test:unit': 'vitest' }) {
  const root = makeProject(scripts);
  const project = ensureProject(store, root);
  const packagePath = join(root, 'package.json');
  const target = { projectId: project.id, projectRoot: root, packagePath };
  const run = (name: string, outcome: HookToolEvent['outcome'], opts: { session?: string; at?: string; failure?: HookToolEvent['failure_code'] } = {}): void => {
    const read = readPackageJson(packagePath, root);
    const session = opts.session ?? 's1';
    touchSession(store, session, project.id, opts.at);
    recordHookToolEvent(
      store,
      {
        kind: 'tool',
        event_type: outcome === 'success' ? 'PostToolUse' : 'PostToolUseFailure',
        session_id: session,
        tool_use_id: `toolu_${++seq}`,
        prompt_id: null,
        cwd: root,
        command_family: 'npm_script',
        command_name: name,
        outcome,
        failure_code: opts.failure ?? (outcome === 'failure' ? 'NPM_MISSING_SCRIPT' : null),
        duration_ms: null,
      },
      { projectId: project.id, packagePath, packageHash: read.ok ? read.pkg.hash : null, ...(opts.at ? { observedAt: opts.at } : {}) },
    );
    evaluatePackage(store, target, opts.at);
  };
  return { root, project, packagePath, target, run };
}
