import { benchmarkProjectId } from '@kilocode/auto-routing-contracts';
import { projectDisplayLabel, projectDisplayLabels } from './project-labels';

const ROUTER_ID = '0f3c2b1a-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const OTHER_ROUTER_ID = 'aa11bb22-cc33-4d44-8e55-ff6677889900';
const UNATTRIBUTED = 'Unattributed';

describe('projectDisplayLabel', () => {
  it('names a benchmark pool and keeps ordinary projects unchanged', () => {
    const pool = benchmarkProjectId({ scope: 'org', slug: 'my-pool', routerId: ROUTER_ID });
    expect(projectDisplayLabel(pool, UNATTRIBUTED)).toBe('my-pool (benchmark pool)');
    expect(projectDisplayLabel('handbook', UNATTRIBUTED)).toBe('handbook');
  });

  it('labels the empty DBT sentinel as unattributed', () => {
    expect(projectDisplayLabel('', UNATTRIBUTED)).toBe(UNATTRIBUTED);
  });

  it('does not treat a malformed reserved value as a benchmark pool', () => {
    for (const value of [
      'Auto-routing benchmarks / org/my-pool',
      'Auto-routing benchmarks / org/my-pool/not-a-uuid',
      'Auto-routing benchmarks / team/my-pool/0f3c2b1a-4d5e-4f60-8a9b-0c1d2e3f4a5b',
    ]) {
      expect(projectDisplayLabel(value, UNATTRIBUTED)).toBe(value);
    }
  });
});

describe('projectDisplayLabels', () => {
  it('disambiguates two pools that share a slug and leaves the rest plain', () => {
    const first = benchmarkProjectId({ scope: 'org', slug: 'shared', routerId: ROUTER_ID });
    const second = benchmarkProjectId({ scope: 'org', slug: 'shared', routerId: OTHER_ROUTER_ID });
    const solo = benchmarkProjectId({ scope: 'user', slug: 'solo', routerId: ROUTER_ID });
    const labels = projectDisplayLabels([first, second, solo, 'handbook', ''], UNATTRIBUTED);

    expect(labels.get(first)).toBe(`shared (benchmark pool, ${ROUTER_ID.slice(0, 8)})`);
    expect(labels.get(second)).toBe(`shared (benchmark pool, ${OTHER_ROUTER_ID.slice(0, 8)})`);
    expect(labels.get(solo)).toBe('solo (benchmark pool)');
    expect(labels.get('handbook')).toBe('handbook');
    expect(labels.get('')).toBe(UNATTRIBUTED);
    // The full identifier stays the key, so distinct pools never collide.
    expect(labels.size).toBe(5);
  });

  it('labels a single pool without a router suffix', () => {
    const pool = benchmarkProjectId({ scope: 'user', slug: 'only', routerId: ROUTER_ID });
    expect(projectDisplayLabels([pool], UNATTRIBUTED).get(pool)).toBe('only (benchmark pool)');
  });
});
