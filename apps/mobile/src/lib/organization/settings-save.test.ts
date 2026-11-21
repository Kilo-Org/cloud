import { type TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { settingsSaveStatus } from '@/lib/organization/settings-save';

/** The catalog's own key, so the status line's source is what is asserted. */
const t = ((key: string) => key) as unknown as TFunction;

const saved = { status: 'succeeded' } as const;

describe('settingsSaveStatus', () => {
  it('reports a save only while the draft is still what was saved', () => {
    expect(
      settingsSaveStatus({ t, feedback: saved, draftIsDirty: false, blockingIssue: null })
    ).toBe('organizationGuardrails.statusSaved');
    expect(
      settingsSaveStatus({ t, feedback: saved, draftIsDirty: true, blockingIssue: null })
    ).toBe('securityAgent.settingsSave.unsavedTitle');
  });

  it('reports a blocking issue that appeared after a save instead of the save', () => {
    expect(
      settingsSaveStatus({
        t,
        feedback: saved,
        draftIsDirty: true,
        blockingIssue: 'organizationGuardrails.ruleTextRequired',
      })
    ).toBe('organizationGuardrails.ruleTextRequired');
  });

  it('keeps a failure in front of the draft state', () => {
    expect(
      settingsSaveStatus({
        t,
        feedback: { status: 'failed', failure: { kind: 'save-failed', message: 'Nope' } },
        draftIsDirty: true,
        blockingIssue: 'organizationGuardrails.ruleTextRequired',
      })
    ).toBe('Nope');
  });
});
