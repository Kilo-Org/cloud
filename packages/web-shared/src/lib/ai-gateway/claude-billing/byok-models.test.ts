jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/drizzle'),
  readDb: { replica: true },
}));
jest.mock('./store', () => ({ getGrantedClaudeBillingConnection: jest.fn() }));
jest.mock('./operator', () => ({
  getClaudeOperatorToken: jest.fn(),
  isClaudeOperatorConfigured: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  resolveOpenRouterModelAlias: jest.fn(async (model: string) =>
    model === '~anthropic/latest' ? 'anthropic/claude-sonnet-4.6' : model
  ),
}));
jest.mock('@kilocode/web-shared/lib/auth/claude/feature-flag.server', () => ({
  isClaudePlatformOAuthEnabled: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => ({
  findUserById: jest.fn(),
}));
import { beforeEach, describe, expect, it } from '@jest/globals';
import { captureException } from '@sentry/nextjs';
import type { ClaudeBillingConnectionRow } from '@kilocode/db/schema';
import { getGrantedClaudeBillingConnection, type ClaudeBillingOwner } from './store';
import { isClaudeOperatorConfigured } from './operator';
import { tagClaudeBillingByokModels } from './routing';
import { isClaudePlatformOAuthEnabled } from '@kilocode/web-shared/lib/auth/claude/feature-flag.server';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';

const row: ClaudeBillingConnectionRow = {
  id: 'row',
  kilo_user_id: 'user',
  organization_id: null,
  user_profile_id: 'uprof_test',
  connection_id: 'ocon_test',
  status: 'connected',
  connected_at: '2026-01-01T00:00:00Z',
  last_refusal_code: null,
  last_refusal_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: 'connector',
};

const { readDb: replica } = jest.requireMock<{ readDb: never }>('@kilocode/web-shared/lib/drizzle');

const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: 'user' };
const sharedServices: ClaudeBillingOwner = {
  kind: 'shared_services',
  organizationId: '00000000-0000-4000-8000-000000000001',
};

type Model = { id: string; hasUserByokAvailable?: boolean };

const models: Model[] = [
  { id: 'anthropic/claude-sonnet-4.6' },
  { id: '~anthropic/latest' },
  { id: 'openai/gpt-5.4-mini' },
  { id: 'anthropic/not-a-model' },
];

beforeEach(() => {
  jest.mocked(captureException).mockReset();
  jest.mocked(getGrantedClaudeBillingConnection).mockReset().mockResolvedValue(row);
  jest.mocked(isClaudeOperatorConfigured).mockReset().mockReturnValue(true);
  jest.mocked(isClaudePlatformOAuthEnabled).mockReset().mockResolvedValue(true);
  jest
    .mocked(findUserById)
    .mockReset()
    .mockResolvedValue({ id: 'connector', google_user_email: 'connector@kilocode.ai' } as never);
});

describe('tagClaudeBillingByokModels', () => {
  it('tags the Claude models a connected, enabled connection serves', async () => {
    expect(await tagClaudeBillingByokModels(personal, models, 'requester@kilocode.ai')).toEqual([
      { id: 'anthropic/claude-sonnet-4.6', hasUserByokAvailable: true },
      { id: '~anthropic/latest', hasUserByokAvailable: true },
      { id: 'openai/gpt-5.4-mini' },
      { id: 'anthropic/not-a-model' },
    ]);
    expect(getGrantedClaudeBillingConnection).toHaveBeenCalledWith(personal, replica);
    expect(isClaudePlatformOAuthEnabled).toHaveBeenCalledWith('requester@kilocode.ai');
    expect(findUserById).not.toHaveBeenCalled();
  });

  it.each(['pending', 'billing_unavailable', 'removed'] as const)(
    'leaves the list unchanged for a %s connection',
    async status => {
      jest.mocked(getGrantedClaudeBillingConnection).mockResolvedValue({ ...row, status });
      const result = await tagClaudeBillingByokModels(personal, models, 'requester@kilocode.ai');
      expect(result).toBe(models);
      expect(isClaudePlatformOAuthEnabled).not.toHaveBeenCalled();
    }
  );

  it('leaves the list unchanged without a connection', async () => {
    jest.mocked(getGrantedClaudeBillingConnection).mockResolvedValue(null);
    expect(await tagClaudeBillingByokModels(personal, models, 'requester@kilocode.ai')).toBe(
      models
    );
  });

  it('leaves the list unchanged when the release flag is off', async () => {
    jest.mocked(isClaudePlatformOAuthEnabled).mockResolvedValue(false);
    expect(await tagClaudeBillingByokModels(personal, models, 'requester@kilocode.ai')).toBe(
      models
    );
  });

  it('leaves the list unchanged when the operator is not configured', async () => {
    jest.mocked(isClaudeOperatorConfigured).mockReturnValue(false);
    expect(await tagClaudeBillingByokModels(personal, models, 'requester@kilocode.ai')).toBe(
      models
    );
    expect(getGrantedClaudeBillingConnection).not.toHaveBeenCalled();
  });

  it('skips the lookup for a member connection without a requester email', async () => {
    const member: ClaudeBillingOwner = {
      kind: 'member',
      kiloUserId: 'user',
      organizationId: 'organization',
    };
    expect(await tagClaudeBillingByokModels(member, models, null)).toBe(models);
    expect(getGrantedClaudeBillingConnection).not.toHaveBeenCalled();
  });

  it('gates a shared-services connection on the person who connected it', async () => {
    jest
      .mocked(isClaudePlatformOAuthEnabled)
      .mockImplementation(async email => email === 'connector@kilocode.ai');
    const result = await tagClaudeBillingByokModels(sharedServices, models, null);
    expect(result[0]).toEqual({ id: 'anthropic/claude-sonnet-4.6', hasUserByokAvailable: true });
    expect(getGrantedClaudeBillingConnection).toHaveBeenCalledWith(sharedServices, replica);
    expect(findUserById).toHaveBeenCalledWith('connector', replica);
  });

  it('does not overwrite an existing BYOK tag', async () => {
    const tagged = [
      { id: 'openai/gpt-5.4-mini', hasUserByokAvailable: true },
      { id: 'anthropic/claude-sonnet-4.6', hasUserByokAvailable: true },
      { id: 'anthropic/claude-haiku-4.5', hasUserByokAvailable: false },
    ];
    expect(await tagClaudeBillingByokModels(personal, tagged, 'requester@kilocode.ai')).toEqual([
      { id: 'openai/gpt-5.4-mini', hasUserByokAvailable: true },
      { id: 'anthropic/claude-sonnet-4.6', hasUserByokAvailable: true },
      { id: 'anthropic/claude-haiku-4.5', hasUserByokAvailable: true },
    ]);
  });

  it('reports a failed lookup and leaves the list unchanged', async () => {
    const error = new Error('replica unavailable');
    jest.mocked(getGrantedClaudeBillingConnection).mockRejectedValue(error);
    expect(await tagClaudeBillingByokModels(personal, models, 'requester@kilocode.ai')).toBe(
      models
    );
    expect(captureException).toHaveBeenCalledWith(error, expect.anything());
  });
});
