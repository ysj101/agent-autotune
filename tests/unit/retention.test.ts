import { describe, expect, it } from 'vitest';
import { loadHints } from '../../src/commands/hint-view.js';
import { applyRetention } from '../../src/store/retention.js';
import { openStore } from '../../src/store/sqlite.js';
import { evaluatePackage } from '../../src/rules/engine.js';
import { scenario } from '../helpers/scenario.js';

const NOW = new Date('2026-11-12T00:00:00.000Z');
const ago = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const count = (store: ReturnType<typeof openStore>, table: string): number => (store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

describe('retention', () => {
  it('drops tool events after 30 days and history after 90 days', () => {
    const store = openStore(':memory:');
    const s = scenario(store);
    s.run('test', 'failure', { at: ago(40), session: 'old' });
    s.run('test:unit', 'success', { at: ago(10), session: 'recent' });
    store.db.prepare("UPDATE hints SET state = 'stale', updated_at = ?").run(ago(100));
    store.db.prepare("INSERT INTO hint_deliveries SELECT 'old', id, 1, ? FROM hints").run(ago(100));
    store.audit({ action: 'old.thing' }, ago(100));
    store.audit({ action: 'new.thing' }, ago(1));
    store.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE session_id = 'old'").run(ago(100));
    store.db
      .prepare("INSERT INTO metric_points VALUES ('claude_code.cost.usage', '{}', ?, ?, ?, 'delta', 1)")
      .run(ago(40), ago(40), ago(40).slice(0, 10));

    const r = applyRetention(store, NOW);
    expect(r).toMatchObject({ toolEvents: 1, metricPoints: 1, hints: 1, deliveries: 1, sessions: 1 });
    expect(count(store, 'tool_events')).toBe(1);
    expect(count(store, 'hints')).toBe(0);
    const actions = (store.db.prepare('SELECT action FROM audit_events').all() as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['new.thing', 'retention.applied']));
    expect(actions).not.toContain('old.thing');
  });

  it('keeps hints that can still be injected', () => {
    const store = openStore(':memory:');
    const s = scenario(store);
    s.run('test', 'failure', { at: ago(200) });
    s.run('test:unit', 'success', { at: ago(200) });
    applyRetention(store, NOW);
    expect(loadHints(store).map((h) => h.state)).toEqual(['active']);
    expect(count(store, 'tool_events')).toBe(0);
  });

  it('does not treat evidence that aged out as a contradiction', () => {
    const store = openStore(':memory:');
    const s = scenario(store);
    s.run('test', 'failure', { at: ago(40) });
    s.run('test:unit', 'success', { at: ago(40) });
    applyRetention(store, NOW);
    s.run('test', 'failure', { at: ago(1) });
    evaluatePackage(store, s.target);
    expect(loadHints(store).map((h) => h.state)).toEqual(['active']);
    expect(JSON.parse(loadHints(store)[0]!.evidence_event_ids_json).length).toBeGreaterThanOrEqual(3);
  });

  it('is a no-op on recent data', () => {
    const store = openStore(':memory:');
    const s = scenario(store);
    s.run('test', 'failure');
    expect(Object.values(applyRetention(store)).every((n) => n === 0)).toBe(true);
    expect(count(store, 'audit_events')).toBe(1);
  });
});
