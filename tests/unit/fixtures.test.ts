import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../fixtures/', import.meta.url);
const read = (p: string): unknown => JSON.parse(readFileSync(new URL(p, dir), 'utf8'));

interface Attr {
  key: string;
  value: Record<string, unknown>;
}

function otelToolResults(): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const f of readdirSync(new URL('otlp/', dir)).filter((n) => n.startsWith('logs-'))) {
    const body = read(`otlp/${f}`) as { resourceLogs: { scopeLogs: { logRecords: { attributes: Attr[] }[] }[] }[] };
    for (const rl of body.resourceLogs)
      for (const sl of rl.scopeLogs)
        for (const lr of sl.logRecords) {
          const attrs = Object.fromEntries(lr.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
          if (attrs['event.name'] === 'tool_result') out.set(String(attrs['tool_use_id']), attrs);
        }
  }
  return out;
}

describe('real-device fixtures', () => {
  it('join hook and OTel events by tool_use_id (Go/No-Go)', () => {
    const otel = otelToolResults();
    for (const f of readdirSync(new URL('hooks/', dir)).filter((n) => n.startsWith('post-tool-use'))) {
      const hook = read(`hooks/${f}`) as { tool_use_id: string; session_id: string; hook_event_name: string };
      const match = otel.get(hook.tool_use_id);
      expect(match, f).toBeDefined();
      expect(match?.['session.id']).toBe(hook.session_id);
      expect(match?.['success']).toBe(hook.hook_event_name === 'PostToolUse' ? 'true' : 'false');
    }
  });

  it('contain no real personal data', () => {
    const all = ['hooks', 'otlp']
      .flatMap((d) => readdirSync(new URL(`${d}/`, dir)).map((f) => readFileSync(new URL(`${d}/${f}`, dir), 'utf8')))
      .join('\n');
    const emails = all.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi) ?? [];
    expect(new Set(emails)).toEqual(new Set(['dev@example.com']));
    expect(all).not.toMatch(/\/Users\/(?!dev\/)/);
  });
});
