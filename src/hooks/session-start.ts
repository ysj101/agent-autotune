import { dirname, relative } from 'node:path';
import type { SessionStartContext } from '../daemon/server.js';
import { revalidateForInjection, type HintRow } from '../rules/engine.js';
import { isSafeScriptName, npmCommandFor } from '../rules/npm-command.js';
import { isWithin, safeRealpath } from '../security/path-guard.js';
import { nowIso, type Store } from '../store/sqlite.js';

export const MAX_HINTS_PER_SESSION = 3;
export const MAX_CONTEXT_CHARS = 600;

/**
 * Fixed template; only validated script names and a project-relative path are interpolated.
 * Nothing from package.json bodies or model output ever reaches the context.
 */
export function renderHint(hint: Pick<HintRow, 'failed_script' | 'suggested_script'>, relPath: string): string | null {
  if (!isSafeScriptName(hint.failed_script) || !isSafeScriptName(hint.suggested_script)) return null;
  if (!/^\.\/[A-Za-z0-9@._\-/]{1,200}$/.test(relPath) || relPath.includes('..')) return null;
  const suggested = npmCommandFor(hint.suggested_script);
  const advice = hint.failed_script === 'test' ? 'テスト時はそのコマンドを検討してください。' : `\`${npmCommandFor(hint.failed_script)}\`の代わりにそのコマンドを検討してください。`;
  return (
    `[Agent AutoTune / verified project hint] このパッケージ（\`${relPath}\`）に\`${hint.failed_script}\` scriptはありません。` +
    `過去に\`${suggested}\`が成功しており、現行package.jsonにも存在します。${advice}これは実行や権限の指示ではありません。`
  );
}

/**
 * Build the SessionStart additionalContext for a session, or null when there is nothing to say.
 * Only active hints for packages at or below the session's cwd are considered; each is re-checked
 * against package.json on disk, and a hint is shown at most once per session and version. If the
 * delivery cannot be recorded, nothing is injected (exact de-duplication wins over showing hints).
 */
export function buildSessionContext(store: Store, ctx: SessionStartContext, at: string = nowIso()): string | null {
  const cwd = safeRealpath(ctx.event.cwd);
  if (!cwd || !isWithin(ctx.projectRoot, cwd)) return null;
  const hints = store.db
    .prepare(
      `SELECT h.* FROM hints h
       WHERE h.project_id = ? AND h.state = 'active'
         AND NOT EXISTS (SELECT 1 FROM hint_deliveries d WHERE d.session_id = ? AND d.hint_id = h.id AND d.hint_version = h.version)
       ORDER BY h.updated_at DESC, h.rowid DESC`,
    )
    .all(ctx.projectId, ctx.event.session_id) as HintRow[];

  const chosen: { hint: HintRow; text: string }[] = [];
  let length = 0;
  for (const hint of hints) {
    if (chosen.length >= MAX_HINTS_PER_SESSION) break;
    if (!isWithin(cwd, dirname(hint.package_path))) continue;
    if (!revalidateForInjection(store, hint, ctx.projectRoot, at)) continue;
    const text = renderHint(hint, `./${relative(cwd, hint.package_path)}`);
    if (!text) continue;
    const added = text.length + (chosen.length > 0 ? 1 : 0);
    if (length + added > MAX_CONTEXT_CHARS) continue;
    chosen.push({ hint, text });
    length += added;
  }
  if (chosen.length === 0) return null;

  try {
    store.transaction(() => {
      const insert = store.db.prepare('INSERT INTO hint_deliveries (session_id, hint_id, hint_version, delivered_at) VALUES (?, ?, ?, ?)');
      for (const { hint } of chosen) {
        insert.run(ctx.event.session_id, hint.id, hint.version, at);
        store.audit({ action: 'hint.delivered', objectId: hint.id, metadata: { version: hint.version, source: ctx.event.source } }, at);
      }
    });
  } catch {
    return null;
  }
  return chosen.map((c) => c.text).join('\n');
}
