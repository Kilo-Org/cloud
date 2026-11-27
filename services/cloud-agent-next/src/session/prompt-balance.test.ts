import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BalanceValidationModule from '../balance-validation.js';
import type * as SessionAccessModule from '../session-access.js';
import type { Env } from '../types.js';

const { requireCurrentSessionAccessMock, validateBalanceOnlyMock } = vi.hoisted(() => ({
  requireCurrentSessionAccessMock: vi.fn(),
  validateBalanceOnlyMock: vi.fn(),
}));

vi.mock('../session-access.js', async importOriginal => ({
  ...(await importOriginal<typeof SessionAccessModule>()),
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
}));

vi.mock('../balance-validation.js', async importOriginal => ({
  ...(await importOriginal<typeof BalanceValidationModule>()),
  validateBalanceOnly: validateBalanceOnlyMock,
}));

import { defaultValidatePromptBalance } from './prompt-balance.js';

const env = {} as unknown as Env;
const cloudAgentSessionId = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('the payer balance preflight', () => {
  beforeEach(() => {
    requireCurrentSessionAccessMock.mockReset();
    validateBalanceOnlyMock.mockReset().mockResolvedValue({ success: true });
  });

  it('validates the resolved organization payer without reading the scope', async () => {
    await defaultValidatePromptBalance({
      env,
      authToken: 'token',
      userId: 'user_abc',
      cloudAgentSessionId,
      resolvedPayer: { organizationId: 'org-funded' },
    });

    expect(validateBalanceOnlyMock).toHaveBeenCalledExactlyOnceWith(
      'token',
      'org-funded',
      env,
      undefined
    );
    expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
  });

  it('validates the resolved personal payer without reading the scope', async () => {
    await defaultValidatePromptBalance({
      env,
      authToken: 'token',
      userId: 'user_abc',
      cloudAgentSessionId,
      resolvedPayer: { organizationId: null },
    });

    expect(validateBalanceOnlyMock).toHaveBeenCalledExactlyOnceWith(
      'token',
      undefined,
      env,
      undefined
    );
    expect(requireCurrentSessionAccessMock).not.toHaveBeenCalled();
  });

  it('reads the payer when the caller resolved none', async () => {
    requireCurrentSessionAccessMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org-read',
    });

    await defaultValidatePromptBalance({
      env,
      authToken: 'token',
      userId: 'user_abc',
      cloudAgentSessionId,
    });

    expect(requireCurrentSessionAccessMock).toHaveBeenCalledExactlyOnceWith({
      env,
      kiloUserId: 'user_abc',
      cloudAgentSessionId,
    });
    expect(validateBalanceOnlyMock).toHaveBeenCalledExactlyOnceWith(
      'token',
      'org-read',
      env,
      undefined
    );
  });

  it('reads the payer when the caller passes no resolved payer value', async () => {
    requireCurrentSessionAccessMock.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: 'org-read',
    });

    await defaultValidatePromptBalance({
      env,
      authToken: 'token',
      userId: 'user_abc',
      cloudAgentSessionId,
      resolvedPayer: undefined,
    });

    expect(requireCurrentSessionAccessMock).toHaveBeenCalledTimes(1);
    expect(validateBalanceOnlyMock).toHaveBeenCalledExactlyOnceWith(
      'token',
      'org-read',
      env,
      undefined
    );
  });
});
