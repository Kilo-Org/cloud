jest.mock('./store', () => ({ getGrantedClaudeBillingConnection: jest.fn() }));
jest.mock('./operator', () => ({ isClaudeOperatorConfigured: jest.fn() }));
jest.mock('./routing', () => ({
  resolveClaudeBillingModel: jest.fn(async (id: string) =>
    id.startsWith('anthropic/claude') ? id : null
  ),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ readDb: {} }));

import { beforeEach, describe, expect, it } from '@jest/globals';
import type { ClaudeBillingConnectionRow } from '@kilocode/db/schema';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import { getGrantedClaudeBillingConnection } from './store';
import { isClaudeOperatorConfigured } from './operator';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { tagClaudeBillingByokModels } from './byok-models';

const owner = { kind: 'personal', kiloUserId: 'user-1' } as const;
const models = [
  { id: 'anthropic/claude-sonnet-4.6' },
  { id: 'openai/gpt-5' },
  { id: 'anthropic/claude-opus-4.6', hasUserByokAvailable: true },
];

function connection(status: ClaudeBillingConnectionStatus) {
  return { status } as ClaudeBillingConnectionRow;
}

describe('tagClaudeBillingByokModels', () => {
  beforeEach(() => {
    jest.mocked(isClaudeOperatorConfigured).mockReset().mockReturnValue(true);
    jest
      .mocked(getGrantedClaudeBillingConnection)
      .mockReset()
      .mockResolvedValue(connection(ClaudeBillingConnectionStatus.Connected));
  });

  it('tags only the Claude models a connected link serves', async () => {
    await expect(tagClaudeBillingByokModels(owner, models)).resolves.toEqual([
      { id: 'anthropic/claude-sonnet-4.6', hasUserByokAvailable: true },
      { id: 'openai/gpt-5' },
      { id: 'anthropic/claude-opus-4.6', hasUserByokAvailable: true },
    ]);
    const [calledOwner, fromDb] = jest.mocked(getGrantedClaudeBillingConnection).mock.calls[0];
    expect(calledOwner).toEqual(owner);
    expect(fromDb).toBe(readDb);
  });

  it.each([
    ClaudeBillingConnectionStatus.BillingUnavailable,
    ClaudeBillingConnectionStatus.Removed,
  ])('leaves the list unchanged for a %s link', async status => {
    jest.mocked(getGrantedClaudeBillingConnection).mockResolvedValue(connection(status));
    await expect(tagClaudeBillingByokModels(owner, models)).resolves.toBe(models);
  });

  it('leaves the list unchanged without a link', async () => {
    jest.mocked(getGrantedClaudeBillingConnection).mockResolvedValue(null);
    await expect(tagClaudeBillingByokModels(owner, models)).resolves.toBe(models);
  });

  it('skips the lookup when Kilo cannot bill through Claude', async () => {
    jest.mocked(isClaudeOperatorConfigured).mockReturnValue(false);
    await expect(tagClaudeBillingByokModels(owner, models)).resolves.toBe(models);
    expect(getGrantedClaudeBillingConnection).not.toHaveBeenCalled();
  });
});
