import { describe, expect, it } from 'vitest';
import { runRules } from '../../src/commands/rules.js';
import { evaluatePackage } from '../../src/rules/engine.js';
import { openStore } from '../../src/store/sqlite.js';
import { writePackage } from '../helpers/project.js';
import { scenario } from '../helpers/scenario.js';
import { tmpPaths } from '../helpers/tmp.js';

function setup() {
  const paths = tmpPaths();
  const store = openStore(paths.dbFile);
  const s = scenario(store);
  s.run('test', 'failure');
  s.run('test:unit', 'success');
  return { paths, store, s };
}

async function rules(paths: ReturnType<typeof tmpPaths>, opts = {}): Promise<string> {
  const out: string[] = [];
  await runRules(opts, { paths, io: { out: (l) => out.push(l), err: (l) => out.push(l) } });
  return out.join('\n');
}

describe('rules', () => {
  it('lists hints with evidence and state', async () => {
    const { paths, store } = setup();
    store.close();
    const text = await rules(paths);
    expect(text).toMatch(/^[0-9a-f]{8} {2}\[active\] aat-proj-\w+\/package\.json {2}\(R001\)$/m);
    expect(text).toContain('  npm test → npm run test:unit');
    expect(text).toContain('  evidence: 1 failure(s), 1 success(es); delivered to 0 session(s)');
    expect(text).toContain('  validation: package hash matched');
  });

  it('shows why a hint stopped and filters by state', async () => {
    const { paths, store, s } = setup();
    writePackage(s.root, { build: 'tsc' });
    evaluatePackage(store, s.target);
    store.close();
    const text = await rules(paths);
    expect(text).toContain('[stale]');
    expect(text).toContain('  stopped: SCRIPT_REMOVED');
    expect(await rules(paths, { state: 'active' })).toBe('No hints in state active.');
  });

  it('prints JSON', async () => {
    const { paths, store } = setup();
    store.close();
    const [row] = JSON.parse(await rules(paths, { json: true }));
    expect(row).toMatchObject({ rule: 'R001', state: 'active', missing: 'npm test', suggested: 'npm run test:unit', evidence: { failures: 1, successes: 1 } });
  });

  it('handles an empty install', async () => {
    expect(await rules(tmpPaths())).toBe('No hints yet.');
    expect(await rules(tmpPaths(), { json: true })).toBe('[]');
  });
});
