import { existsSync } from 'node:fs';
import { updateConfig } from '../config/app-config.js';
import { resolvePaths, type Paths } from '../config/paths.js';
import { transition, type HintRow } from '../rules/engine.js';
import { openStore } from '../store/sqlite.js';
import { consoleIo, type Io } from './common.js';

export interface ToggleDeps {
  paths: Paths;
  io: Io;
}

const defaults = (): ToggleDeps => ({ paths: resolvePaths(), io: consoleIo });
const MIN_PREFIX = 4;

function auditIfPossible(paths: Paths, action: string): void {
  if (!existsSync(paths.dbFile)) return;
  const store = openStore(paths.dbFile);
  try {
    store.audit({ action });
  } finally {
    store.close();
  }
}

/**
 * Stop (or resume) everything: while disabled the hook exits silently without contacting the
 * daemon, and the daemon accepts but discards OTLP and hook events. Settings are kept.
 */
export function runSetEnabled(enabled: boolean, deps: ToggleDeps = defaults()): number {
  updateConfig(deps.paths, { enabled });
  auditIfPossible(deps.paths, enabled ? 'autotune.enabled' : 'autotune.disabled');
  deps.io.out(
    enabled
      ? 'Agent AutoTune enabled: recording and hint injection resume.'
      : 'Agent AutoTune disabled: no hints are injected and nothing is recorded. Settings are kept; `agent-autotune enable` resumes.',
  );
  return 0;
}

/** Permanently stop one hint (by full id or a unique prefix of at least 4 characters). */
export function runDisableRule(idOrPrefix: string, deps: ToggleDeps = defaults()): number {
  const { paths, io } = deps;
  if (!/^[0-9a-f-]+$/i.test(idOrPrefix) || idOrPrefix.length < MIN_PREFIX) {
    io.err(`disable: give a hint id or at least ${MIN_PREFIX} characters of it (see \`agent-autotune rules\`)`);
    return 1;
  }
  if (!existsSync(paths.dbFile)) {
    io.err(`disable: no hint ${idOrPrefix}`);
    return 1;
  }
  const store = openStore(paths.dbFile);
  try {
    const matches = store.db.prepare('SELECT * FROM hints WHERE id LIKE ?').all(`${idOrPrefix.toLowerCase()}%`) as HintRow[];
    if (matches.length === 0) {
      io.err(`disable: no hint ${idOrPrefix}`);
      return 1;
    }
    if (matches.length > 1) {
      io.err(`disable: ${idOrPrefix} matches ${matches.length} hints; give more characters`);
      return 1;
    }
    const hint = matches[0]!;
    if (hint.state === 'disabled') {
      io.out(`Hint ${hint.id.slice(0, 8)} is already disabled.`);
      return 0;
    }
    store.transaction(() => transition(store, hint, 'disabled', 'USER_DISABLED'));
    io.out(`Hint ${hint.id.slice(0, 8)} disabled; it will not be injected again.`);
    return 0;
  } finally {
    store.close();
  }
}
