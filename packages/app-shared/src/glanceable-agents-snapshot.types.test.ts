/**
 * Negative type cases for the snapshot status override. The `@ts-expect-error`
 * directives are checked by `pnpm typecheck`, whose tsconfig includes every
 * TypeScript file.
 */
import { describe, expect, it } from 'vitest';

import {
  buildGlanceableSnapshot,
  type BuildGlanceableSnapshotInput,
  type GlanceableSnapshotStatusOverride,
} from './glanceable-agents-snapshot';

const BASE = {
  sessions: [{ status: 'busy' }],
  userId: 'u1',
  organizationId: null,
  now: 1_750_000_000_000,
};

const forcedHappy = () => {
  // @ts-expect-error happy comes from the counts; an override could only contradict them
  return buildGlanceableSnapshot({ ...BASE, status: 'happy' });
};
const forcedEmpty = () => {
  // @ts-expect-error empty comes from the counts; an override could only contradict them
  return buildGlanceableSnapshot({ ...BASE, status: 'empty' });
};
void forcedHappy;
void forcedEmpty;

describe('snapshot status override', () => {
  it('admits every documented override', () => {
    const overrides: GlanceableSnapshotStatusOverride[] = [
      'waiting',
      'stale',
      'expired',
      'signed_out',
      'privacy',
    ];
    for (const status of overrides) {
      const input: BuildGlanceableSnapshotInput = { ...BASE, status };
      expect(buildGlanceableSnapshot(input).status).toBe(status);
    }
  });

  it('derives the two statuses a caller cannot force', () => {
    expect(buildGlanceableSnapshot(BASE).status).toBe('happy');
    expect(buildGlanceableSnapshot({ ...BASE, sessions: [] }).status).toBe('empty');
  });
});
