import { describe, expect, it } from '@jest/globals';
import type { OrganizationOnboardingChecklist } from '@/lib/organizations/onboarding-checklist';
import {
  buildOrganizationWelcomePath,
  getFirstIncompleteOnboardingScreen,
  getNextOnboardingScreen,
  getOrganizationOnboardingScreen,
  getPreviousOnboardingScreen,
} from './organization-setup-path';

function checklist(done: boolean[]): OrganizationOnboardingChecklist {
  return {
    steps: [
      { key: 'source-control', done: done[0] ?? false },
      { key: 'code-reviewer', done: done[1] ?? false },
      { key: 'invite-team', done: done[2] ?? false },
    ],
    completedCount: done.filter(Boolean).length,
    totalCount: 3,
    connectedPlatform: null,
  };
}

describe('organization setup paths', () => {
  it.each(['source-control', 'code-reviewer', 'invite-team', 'complete'] as const)(
    'parses the %s screen',
    screen => {
      expect(getOrganizationOnboardingScreen(new URLSearchParams({ step: screen }))).toBe(screen);
    }
  );

  it('rejects missing and invalid screens', () => {
    expect(getOrganizationOnboardingScreen(new URLSearchParams())).toBeNull();
    expect(getOrganizationOnboardingScreen(new URLSearchParams({ step: 'unknown' }))).toBeNull();
  });

  it('selects the first incomplete screen and falls back to complete', () => {
    expect(getFirstIncompleteOnboardingScreen(checklist([false, true, false]))).toBe(
      'source-control'
    );
    expect(getFirstIncompleteOnboardingScreen(checklist([true, false, false]))).toBe(
      'code-reviewer'
    );
    expect(getFirstIncompleteOnboardingScreen(checklist([true, true, true]))).toBe('complete');
  });

  it('builds canonical paths and transitions', () => {
    expect(buildOrganizationWelcomePath('org-id', 'source-control')).toBe(
      '/organizations/org-id/welcome?step=source-control'
    );
    expect(
      buildOrganizationWelcomePath('org-id', 'code-reviewer', { code_reviewer_return: 'true' })
    ).toBe('/organizations/org-id/welcome?step=code-reviewer&code_reviewer_return=true');
    expect(getNextOnboardingScreen('invite-team')).toBe('complete');
    expect(getNextOnboardingScreen('complete')).toBe('complete');
    expect(getPreviousOnboardingScreen('source-control')).toBeNull();
    expect(getPreviousOnboardingScreen('complete')).toBe('invite-team');
  });
});
