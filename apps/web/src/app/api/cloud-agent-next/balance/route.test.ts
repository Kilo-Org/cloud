import { GET } from './route';
import { getUserFromAuth } from '@/lib/user/server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { NextResponse } from 'next/server';

jest.mock('@/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/organizations/organization-usage', () => ({
  getBalanceAndOrgSettings: jest.fn(),
}));

const auth = jest.mocked(getUserFromAuth);
const balance = jest.mocked(getBalanceAndOrgSettings);

afterEach(() => jest.resetAllMocks());

it('requires Cloud Agent audience authentication and uses the authorized organization', async () => {
  const user = { id: 'user_123' };
  auth.mockResolvedValue({ user, organizationId: 'org_123' } as Awaited<
    ReturnType<typeof getUserFromAuth>
  >);
  balance.mockResolvedValue({ balance: 12 } as Awaited<
    ReturnType<typeof getBalanceAndOrgSettings>
  >);

  const response = await GET();

  expect(auth).toHaveBeenCalledWith({ adminOnly: false, expectedAudience: 'cloud-agent-next' });
  expect(balance).toHaveBeenCalledWith('org_123', user);
  expect(await response.json()).toEqual({ balance: 12, isDepleted: false });
});

it.each([401, 403])(
  'does not read balances when authentication or organization access fails (%s)',
  async status => {
    const authFailedResponse = NextResponse.json({ error: 'Unauthorized' }, { status });
    auth.mockResolvedValue({ authFailedResponse } as Awaited<ReturnType<typeof getUserFromAuth>>);

    expect(await GET()).toBe(authFailedResponse);
    expect(balance).not.toHaveBeenCalled();
  }
);
