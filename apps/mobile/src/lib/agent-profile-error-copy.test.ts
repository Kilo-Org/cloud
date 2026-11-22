import { describe, expect, it } from 'vitest';

import {
  agentProfileMutationErrorMessage,
  ORGANIZATION_ROLE_DENIED_MESSAGE,
} from '@/lib/agent-profile-error-copy';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';
import {
  TRIAL_ENDED_BILLING_AT_KILO_AI_COPY_KEY,
  TRIAL_ENDED_COPY_KEY,
} from '@/lib/trial-refusal-copy';
import { i18n } from '@/i18n';

const ENGLISH_ROLE_REFUSAL =
  'Only organization owners and admins can change organization profiles.';
const PORTUGUESE_ROLE_REFUSAL =
  'Somente proprietários e administradores da organização podem alterar os perfis da organização.';

// The profile screens render no billing step of their own, so a reader who can
// change the plan reads the sentence that names the destination, and everyone
// else reads the one that names the owner who can.
describe('agentProfileMutationErrorMessage', () => {
  it('explains the organization-role denial instead of relaying the server sentence', () => {
    const message = agentProfileMutationErrorMessage(ORGANIZATION_ROLE_DENIED_MESSAGE, true);
    expect(message).toBe(ENGLISH_ROLE_REFUSAL);
    expect(message).not.toBe(ORGANIZATION_ROLE_DENIED_MESSAGE);
    // The role denial is the same sentence whoever the plan role lets act.
    expect(agentProfileMutationErrorMessage(ORGANIZATION_ROLE_DENIED_MESSAGE, false)).toBe(
      ENGLISH_ROLE_REFUSAL
    );
  });

  it('offers the destination to a reader who can change the plan', () => {
    const message = agentProfileMutationErrorMessage(ORGANIZATION_TRIAL_EXPIRED_MESSAGE, true);
    expect(message).toBe(i18n.t(TRIAL_ENDED_BILLING_AT_KILO_AI_COPY_KEY));
    expect(message).toBe(
      "The organization's trial has ended and it has no active plan. You can update billing at kilo.ai, then try again."
    );
    // Not the copy for a reader who cannot act, and not the server's sentence.
    expect(message).not.toBe(i18n.t(TRIAL_ENDED_COPY_KEY));
    expect(message).not.toBe(ORGANIZATION_TRIAL_EXPIRED_MESSAGE);
  });

  it('names the owner who can change the plan to everyone else', () => {
    const message = agentProfileMutationErrorMessage(ORGANIZATION_TRIAL_EXPIRED_MESSAGE, false);
    expect(message).toBe(i18n.t(TRIAL_ENDED_COPY_KEY));
    expect(message).toBe(
      "The organization's trial has ended and it has no active plan. An organization owner can update billing at kilo.ai, then try again."
    );
    expect(message).not.toBe(i18n.t(TRIAL_ENDED_BILLING_AT_KILO_AI_COPY_KEY));
  });

  it('renders those explanations in the active language', async () => {
    const englishPlanEnded = agentProfileMutationErrorMessage(
      ORGANIZATION_TRIAL_EXPIRED_MESSAGE,
      true
    );
    await i18n.changeLanguage('pt-BR');
    try {
      expect(agentProfileMutationErrorMessage(ORGANIZATION_ROLE_DENIED_MESSAGE, false)).toBe(
        PORTUGUESE_ROLE_REFUSAL
      );
      const portuguesePlanEndedForBilling = agentProfileMutationErrorMessage(
        ORGANIZATION_TRIAL_EXPIRED_MESSAGE,
        true
      );
      const portuguesePlanEndedForOwner = agentProfileMutationErrorMessage(
        ORGANIZATION_TRIAL_EXPIRED_MESSAGE,
        false
      );
      expect(portuguesePlanEndedForBilling).toBe(
        i18n.t(TRIAL_ENDED_BILLING_AT_KILO_AI_COPY_KEY)
      );
      expect(portuguesePlanEndedForBilling).toBe(
        'O período de teste da organização terminou e ela não tem nenhum plano ativo. Você pode atualizar o faturamento em kilo.ai e tentar novamente.'
      );
      expect(portuguesePlanEndedForOwner).toBe(i18n.t(TRIAL_ENDED_COPY_KEY));
      expect(portuguesePlanEndedForOwner).toBe(
        'O período de teste da organização terminou e ela não tem nenhum plano ativo. Um proprietário da organização pode atualizar o faturamento em kilo.ai e tentar novamente.'
      );
      // The two readers read two different sentences, and the plan sentence is
      // translated rather than the English copy with an accent.
      expect(portuguesePlanEndedForBilling).not.toBe(portuguesePlanEndedForOwner);
      expect(portuguesePlanEndedForBilling).not.toBe(englishPlanEnded);
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
    expect(agentProfileMutationErrorMessage(message, true)).toBe(message);
    expect(agentProfileMutationErrorMessage(message, false)).toBe(message);
  });
});
