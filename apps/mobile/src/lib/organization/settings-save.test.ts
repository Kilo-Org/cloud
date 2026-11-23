import { type TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { settingsSaveStatus } from '@/lib/organization/settings-save';

/** The catalog's own key, so the status line's source is what is asserted. */
const t = ((key: string) => key) as unknown as TFunction;

const saved = { status: 'succeeded' } as const;
const pending = { status: 'pending' } as const;
const idle = { status: 'idle' } as const;

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

  it('says a save is in flight while the attempt is pending', () => {
    expect(
      settingsSaveStatus({ t, feedback: pending, draftIsDirty: false, blockingIssue: null })
    ).toBe('organizationGuardrails.statusSaving');
    expect(
      settingsSaveStatus({ t, feedback: pending, draftIsDirty: true, blockingIssue: null })
    ).toBe('organizationGuardrails.statusSaving');
  });

  it('flags an unsaved or blocked draft while no save is running', () => {
    expect(settingsSaveStatus({ t, feedback: idle, draftIsDirty: true, blockingIssue: null })).toBe(
      'securityAgent.settingsSave.unsavedTitle'
    );
    expect(
      settingsSaveStatus({
        t,
        feedback: idle,
        draftIsDirty: true,
        blockingIssue: 'organizationGuardrails.ruleTextRequired',
      })
    ).toBe('organizationGuardrails.ruleTextRequired');
    expect(
      settingsSaveStatus({ t, feedback: idle, draftIsDirty: false, blockingIssue: null })
    ).toBeNull();
  });
});
