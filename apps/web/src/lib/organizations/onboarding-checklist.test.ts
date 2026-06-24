import { describe, expect, it } from '@jest/globals';
import { buildOrganizationOnboardingChecklist } from './onboarding-checklist';

type OnboardingState = Parameters<typeof buildOrganizationOnboardingChecklist>[0];

function state(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    githubConnected: false,
    codeReviewerEnabled: false,
    teamInvited: false,
    ...overrides,
  };
}

describe('buildOrganizationOnboardingChecklist', () => {
  it('returns the canonical order with no completed steps', () => {
    const checklist = buildOrganizationOnboardingChecklist(state());

    expect(checklist).toEqual({
      steps: [
        { key: 'github', done: false },
        { key: 'code-reviewer', done: false },
        { key: 'invite-team', done: false },
      ],
      completedCount: 0,
      totalCount: 3,
    });
  });

  it.each([
    ['githubConnected', 'github'],
    ['codeReviewerEnabled', 'code-reviewer'],
    ['teamInvited', 'invite-team'],
  ] as const)('maps %s to the %s step', (stateKey, stepKey) => {
    const checklist = buildOrganizationOnboardingChecklist(state({ [stateKey]: true }));

    expect(checklist.completedCount).toBe(1);
    expect(checklist.steps.find(step => step.key === stepKey)?.done).toBe(true);
  });

  it('derives mixed and complete counts from the steps', () => {
    const mixed = buildOrganizationOnboardingChecklist(
      state({ githubConnected: true, teamInvited: true })
    );
    const complete = buildOrganizationOnboardingChecklist(
      state({ githubConnected: true, codeReviewerEnabled: true, teamInvited: true })
    );

    expect(mixed.completedCount).toBe(2);
    expect(mixed.completedCount).toBe(mixed.steps.filter(step => step.done).length);
    expect(complete.completedCount).toBe(3);
    expect(complete.totalCount).toBe(complete.steps.length);
  });
});
