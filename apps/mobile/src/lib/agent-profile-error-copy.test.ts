import { describe, expect, it } from 'vitest';

import {
  agentProfileMutationErrorMessage,
  ORGANIZATION_ROLE_DENIED_MESSAGE,
} from '@/lib/agent-profile-error-copy';
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

  it('renders that explanation in the active language', async () => {
    await i18n.changeLanguage('pt-BR');
    try {
      expect(agentProfileMutationErrorMessage(ORGANIZATION_ROLE_DENIED_MESSAGE)).toBe(
        PORTUGUESE_REFUSAL
      );
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
