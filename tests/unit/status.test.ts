import { describe, expect, it } from 'vitest';
import { hintEffect, MIN_SESSIONS_FOR_EFFECT, runStatus, type StatusDeps } from '../../src/commands/status.js';
import { loadHints } from '../../src/commands/hint-view.js';
import { writeConfig } from '../../src/config/app-config.js';
import { recordMetricPoints } from '../../src/store/metrics.js';
import { openStore } from '../../src/store/sqlite.js';
import { writePackage } from '../helpers/project.js';
import { scenario } from '../helpers/scenario.js';
import { tmpPaths } from '../helpers/tmp.js';

const NOW = new Date('2026-11-12T12:00:00.000Z');

function deps(paths: ReturnType<typeof tmpPaths>, out: string[], over: Partial<StatusDeps> = {}): StatusDeps {
  return { paths, io: { out: (l) => out.push(l), err: (l) => out.push(l) }, now: () => NOW, claudeVersion: () => '2.1.310', health: async () => null, ...over };
}

describe('status', () => {
  it('handles a fresh machine', async () => {
    const out: string[] = [];
    expect(await runStatus(deps(tmpPaths(), out))).toBe(0);
    expect(out.join('\n')).toContain('No data yet');
  });

  it('shows observations, the active hint with evidence and N/A usage', async () => {
    const paths = tmpPaths();
    const store = openStore(paths.dbFile);
    const s = scenario(store);
    s.run('test', 'failure', { at: '2026-11-12T10:00:00.000Z' });
    s.run('test:unit', 'success', { at: '2026-11-12T10:01:00.000Z' });
    store.incrementDiagnostic('otlp.logs.received', '2026-11-12T11:00:00.000Z');
    store.close();
    const out: string[] = [];
    await runStatus(deps(paths, out, { health: async () => ({ ok: true }) }));
    const text = out.join('\n');
    expect(text).toContain('Agent AutoTune v0.1.0  [enabled]');
    expect(text).toContain('Claude Code: detected (2.1.310)');
    expect(text).toContain('OTLP logs: connected    OTLP metrics: no data yet');
    expect(text).toContain('Observed tools (7d): 2 | Classified failures: 1');
    expect(text).toContain('Active hints: 1 | Candidates: 0 | Stale: 0 | Disabled: 0 | Reverted: 0');
    expect(text).toMatch(/\[active\] aat-proj-\w+\/package\.json/);
    expect(text).toContain('  Missing: npm test');
    expect(text).toContain('  Observed success: npm run test:unit');
    expect(text).toContain('  Last validation: package hash matched');
    expect(text).toContain('  Effect: insufficient_data (not delivered yet)');
    expect(text).toContain('sessions N/A | tokens N/A | cost N/A');
  });

  it('reports a changed package.json without changing state', async () => {
    const paths = tmpPaths();
    const store = openStore(paths.dbFile);
    const s = scenario(store);
    s.run('test', 'failure');
    s.run('test:unit', 'success');
    writePackage(s.root, { 'test:unit': 'jest' });
    store.close();
    const out: string[] = [];
    await runStatus(deps(paths, out));
    expect(out.join('\n')).toContain('package hash differs');
    const again = openStore(paths.dbFile);
    expect(loadHints(again)[0]?.state).toBe('active');
  });

  it('shows usage from exported metrics and the disabled state', async () => {
    const paths = tmpPaths();
    writeConfig(paths, { version: 1, port: 43181, enabled: false });
    const store = openStore(paths.dbFile);
    const base = { series_key: '{}', start_time: '2026-11-12T00:00:00.000Z', time: '2026-11-12T00:00:01.000Z', day: '2026-11-12', temporality: 'delta' as const };
    recordMetricPoints(store, [
      { ...base, name: 'claude_code.session.count', value: 3 },
      { ...base, name: 'claude_code.token.usage', value: 1_234_567 },
      { ...base, name: 'claude_code.cost.usage', value: 3.4 },
    ]);
    store.close();
    const out: string[] = [];
    await runStatus(deps(paths, out, { claudeVersion: () => null }));
    const text = out.join('\n');
    expect(text).toContain('[disabled]');
    expect(text).toContain('Claude Code: not found');
    expect(text).toContain('sessions 3 | tokens 1.2M | cost $3.40');
  });
});

describe('hintEffect', () => {
  it('needs enough sessions on both sides before reporting a trend', () => {
    const store = openStore(':memory:');
    const s = scenario(store);
    for (let i = 0; i < MIN_SESSIONS_FOR_EFFECT; i++) s.run('test', 'failure', { session: `b${i}`, at: `2026-11-01T0${i}:00:00.000Z` });
    s.run('test:unit', 'success', { session: 'b0', at: '2026-11-01T09:00:00.000Z' });
    const [hint] = loadHints(store, ['active']);
    store.db.prepare("INSERT INTO hint_deliveries VALUES ('a0', ?, 1, '2026-11-02T00:00:00.000Z')").run(hint!.id);
    expect(hintEffect(store, hint!).verdict).toBe('insufficient_data');
    for (let i = 0; i < MIN_SESSIONS_FOR_EFFECT; i++) s.run('test:unit', 'success', { session: `a${i}`, at: `2026-11-03T0${i}:00:00.000Z` });
    const e = hintEffect(store, hint!);
    expect(e.verdict).toBe('observed');
    expect(e.detail).toContain('5 in 5 sessions before, 0 in 5 after (trend only, not causal)');
  });
});
