import { describe, expect, it } from 'vitest';

import {
  agentProfileMutationErrorMessage,
  ORGANIZATION_ROLE_DENIED_MESSAGE,
} from '@/lib/agent-profile-error-copy';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';
import { TRIAL_ENDED_COPY_KEY } from '@/lib/trial-refusal-copy';
import { i18n } from '@/i18n';

const ENGLISH_REFUSAL = 'Only organization owners and admins can change organization profiles.';
const PORTUGUESE_REFUSAL =
  'Somente proprietários e administradores da organização podem alterar os perfis da organização.';

describe('agentProfileMutationErrorMessage', () => {
  it('explains the organization-role denial instead of relaying the server sentence', () => {
    const message = agentProfileMutationErrorMessage(ORGANIZATION_ROLE_DENIED_MESSAGE);
    expect(message).toBe(ENGLISH_REFUSAL);
    expect(message).not.toBe(ORGANIZATION_ROLE_DENIED_MESSAGE);
  });

  it('explains the lapsed organization plan instead of relaying the server sentence', () => {
    const message = agentProfileMutationErrorMessage(ORGANIZATION_TRIAL_EXPIRED_MESSAGE);
    // The hub's own sentence for the same verdict, so a refused save and the
    // organization hub name one cause.
    expect(message).toBe(i18n.t(TRIAL_ENDED_COPY_KEY));
    expect(message).not.toBe(ORGANIZATION_TRIAL_EXPIRED_MESSAGE);
  });

  it('renders those explanations in the active language', async () => {
    const englishPlanEnded = agentProfileMutationErrorMessage(ORGANIZATION_TRIAL_EXPIRED_MESSAGE);
    await i18n.changeLanguage('pt-BR');
    try {
      expect(agentProfileMutationErrorMessage(ORGANIZATION_ROLE_DENIED_MESSAGE)).toBe(
        PORTUGUESE_REFUSAL
      );
      const portuguesePlanEnded = agentProfileMutationErrorMessage(
        ORGANIZATION_TRIAL_EXPIRED_MESSAGE
      );
      expect(portuguesePlanEnded).toBe(i18n.t(TRIAL_ENDED_COPY_KEY));
      // The plan sentence is translated, not the English copy with an accent.
      expect(portuguesePlanEnded).not.toBe(englishPlanEnded);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it.each([
    // The role gate's sibling: the caller is not in the organization at all.
    'You do not have access to this organization',
    'Organization not found',
    'Network request failed',
  ])('relays an unexplained message unchanged (%s)', message => {
    expect(agentProfileMutationErrorMessage(message)).toBe(message);
  });
});
