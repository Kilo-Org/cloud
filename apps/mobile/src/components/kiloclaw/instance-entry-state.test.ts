import { describe, expect, it } from 'vitest';

import { getKiloClawEntryDecision } from './instance-entry-state';

const personal = { sandboxId: 'personal-1' };
const org = { sandboxId: 'org-1' };

describe('getKiloClawEntryDecision', () => {
  it('waits while instances are unresolved', () => {
    expect(getKiloClawEntryDecision(undefined)).toEqual({ kind: 'loading' });
  });

  it('shows onboarding when there are no instances', () => {
    expect(getKiloClawEntryDecision([])).toEqual({ kind: 'empty' });
  });

  it('redirects directly when exactly one instance exists', () => {
    expect(getKiloClawEntryDecision([personal])).toEqual({
      kind: 'redirect',
      sandboxId: 'personal-1',
    });
  });

  it('shows the picker when multiple instances exist', () => {
    expect(getKiloClawEntryDecision([personal, org])).toEqual({ kind: 'list' });
  });
});
