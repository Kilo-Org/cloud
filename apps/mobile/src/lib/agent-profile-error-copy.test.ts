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

// The profile screens render no billing step of their own, and only a role that
// can change the plan reaches this refusal (the role check runs first), so the
// plan sentence names the destination rather than an owner who is the reader.
describe('agentProfileMutationErrorMessage', () => {
  it('explains the organization-role denial instead of relaying the server sentence', () => {
    const message = agentProfileMutationErrorMessage(ORGANIZATION_ROLE_DENIED_MESSAGE);
    expect(message).toBe(ENGLISH_ROLE_REFUSAL);
    expect(message).not.toBe(ORGANIZATION_ROLE_DENIED_MESSAGE);
  });

  it('offers the destination instead of the owner who is the reader', () => {
    const message = agentProfileMutationErrorMessage(ORGANIZATION_TRIAL_EXPIRED_MESSAGE);
    expect(message).toBe(i18n.t(TRIAL_ENDED_BILLING_AT_KILO_AI_COPY_KEY));
    expect(message).toBe(
      "The organization's trial has ended and it has no active plan. You can update billing at kilo.ai, then try again."
    );
    // Not the copy for a reader who cannot act, and not the server's sentence.
    expect(message).not.toBe(i18n.t(TRIAL_ENDED_COPY_KEY));
    expect(message).not.toBe(ORGANIZATION_TRIAL_EXPIRED_MESSAGE);
  });

  it('renders those explanations in the active language', async () => {
    const englishPlanEnded = agentProfileMutationErrorMessage(ORGANIZATION_TRIAL_EXPIRED_MESSAGE);
    await i18n.changeLanguage('pt-BR');
    try {
      expect(agentProfileMutationErrorMessage(ORGANIZATION_ROLE_DENIED_MESSAGE)).toBe(
        PORTUGUESE_ROLE_REFUSAL
      );
      const portuguesePlanEnded = agentProfileMutationErrorMessage(
        ORGANIZATION_TRIAL_EXPIRED_MESSAGE
      );
      expect(portuguesePlanEnded).toBe(i18n.t(TRIAL_ENDED_BILLING_AT_KILO_AI_COPY_KEY));
      expect(portuguesePlanEnded).toBe(
        'O período de teste da organização terminou e ela não tem nenhum plano ativo. Você pode atualizar o faturamento em kilo.ai e tentar novamente.'
      );
      // Translated, not the English copy with an accent.
      expect(portuguesePlanEnded).not.toBe(englishPlanEnded);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it.each([
    'You do not have access to this organization',
    'Organization not found',
    'Network request failed',
  ])('relays an unexplained message unchanged (%s)', message => {
    expect(agentProfileMutationErrorMessage(message)).toBe(message);
  });
});
