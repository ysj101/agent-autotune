import { basename, relative } from 'node:path';
import { readPackageJson } from '../project/package-json.js';
import type { HintRow } from '../rules/engine.js';
import { npmCommandFor } from '../rules/npm-command.js';
import type { Store } from '../store/sqlite.js';

export interface HintView extends HintRow {
  project_root: string;
}

export function loadHints(store: Store, states?: readonly string[]): HintView[] {
  const where = states?.length ? `WHERE h.state IN (${states.map(() => '?').join(',')})` : '';
  return store.db
    .prepare(`SELECT h.*, p.root_path AS project_root FROM hints h JOIN projects p ON p.id = h.project_id ${where} ORDER BY h.updated_at DESC, h.rowid DESC`)
    .all(...(states ?? [])) as HintView[];
}

/** `project-a/package.json`: the project's directory name plus the package path inside it. */
export function displayPath(h: HintView): string {
  return `${basename(h.project_root)}/${relative(h.project_root, h.package_path)}`;
}

/** Read-only check of the evidence; status/rules never change hint state themselves. */
export function validationText(h: HintView): string {
  const read = readPackageJson(h.package_path, h.project_root);
  if (!read.ok) return `package.json ${read.reason.replace('_', ' ')}`;
  return read.pkg.hash === h.package_hash ? 'package hash matched' : 'package hash differs (invalidated at next use)';
}

export const missingText = (h: HintRow): string => npmCommandFor(h.failed_script);
export const successText = (h: HintRow): string => npmCommandFor(h.suggested_script);
