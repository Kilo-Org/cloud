process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';
process.env.TURNSTILE_SECRET_KEY ||= 'test-turnstile-secret';

const mockLimit = jest.fn();
const mockGetUserFromAuth = jest.fn();
const mockGetUserOrganizationsWithSeats = jest.fn();
const mockIsOrganizationMember = jest.fn();
const mockLinkKiloUser = jest.fn();
const mockUpsertTeamsInstallation = jest.fn();

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: mockLimit,
        })),
      })),
    })),
  },
}));

jest.mock('@/lib/user.server', () => ({
  getUserFromAuth: (...args: unknown[]) => mockGetUserFromAuth(...args),
}));

jest.mock('@/lib/organizations/organizations', () => ({
  getUserOrganizationsWithSeats: (...args: unknown[]) => mockGetUserOrganizationsWithSeats(...args),
  isOrganizationMember: (...args: unknown[]) => mockIsOrganizationMember(...args),
}));

jest.mock('@/lib/bot-identity', () => ({
  ...jest.requireActual('@/lib/bot-identity'),
  linkKiloUser: (...args: unknown[]) => mockLinkKiloUser(...args),
}));

jest.mock('@/lib/integrations/teams-service', () => ({
  upsertTeamsInstallation: (...args: unknown[]) => mockUpsertTeamsInstallation(...args),
}));

jest.mock('@/lib/integrations/slack-service', () => ({
  upsertSlackInstallation: jest.fn(),
}));

jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => {}),
    getState: jest.fn(() => 'state'),
    getAdapter: jest.fn(() => ({ getInstallation: jest.fn() })),
  },
}));

import { createLinkToken } from '@/lib/bot-identity';
import { GET, POST } from './route';

function buildUser() {
  return { id: 'user-1' };
}

function buildToken() {
  return createLinkToken({
    platform: 'teams',
    teamId: 'tenant-1',
    teamName: 'Acme',
    userId: '29:user',
  });
}

describe('chat install integration route', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockGetUserFromAuth.mockReset();
    mockGetUserOrganizationsWithSeats.mockReset();
    mockIsOrganizationMember.mockReset();
    mockLinkKiloUser.mockReset();
    mockUpsertTeamsInstallation.mockReset();

    mockGetUserFromAuth.mockResolvedValue({ user: buildUser(), authFailedResponse: null });
    mockGetUserOrganizationsWithSeats.mockResolvedValue([]);
    mockLinkKiloUser.mockResolvedValue(undefined);
    mockUpsertTeamsInstallation.mockResolvedValue({ id: 'pi_teams' });
  });

  it('shows a connection form when no platform integration exists', async () => {
    mockLimit.mockResolvedValue([]);
    mockGetUserOrganizationsWithSeats.mockResolvedValue([
      { organizationId: 'org-1', organizationName: 'Example Org', role: 'owner' },
    ]);

    const response = await GET(
      new Request(`http://localhost:3000/api/chat/install-integration?token=${buildToken()}`)
    );

    await expect(response.text()).resolves.toContain('Example Org');
    expect(response.status).toBe(200);
    expect(mockLinkKiloUser).not.toHaveBeenCalled();
  });

  it('creates a Teams integration for the selected organization and links the user', async () => {
    const token = buildToken();
    mockLimit.mockResolvedValue([]);
    mockGetUserOrganizationsWithSeats.mockResolvedValue([
      { organizationId: 'org-1', organizationName: 'Example Org', role: 'owner' },
    ]);

    const response = await POST(
      new Request('http://localhost:3000/api/chat/install-integration', {
        method: 'POST',
        body: new URLSearchParams({ token, owner: 'org:org-1' }),
      })
    );

    await expect(response.text()).resolves.toContain('Workspace connected');
    expect(mockUpsertTeamsInstallation).toHaveBeenCalledWith({
      owner: { type: 'org', id: 'org-1' },
      tenantId: 'tenant-1',
      tenantName: 'Acme',
    });
    expect(mockLinkKiloUser).toHaveBeenCalledWith(
      'state',
      {
        platform: 'teams',
        teamId: 'tenant-1',
        teamName: 'Acme',
        userId: '29:user',
      },
      'user-1'
    );
  });

  it('links an existing integration when the user can access it', async () => {
    mockLimit.mockResolvedValue([
      {
        id: 'pi_teams',
        integration_status: 'active',
        owned_by_organization_id: 'org-1',
        owned_by_user_id: null,
      },
    ]);
    mockIsOrganizationMember.mockResolvedValue(true);

    const response = await GET(
      new Request(`http://localhost:3000/api/chat/install-integration?token=${buildToken()}`)
    );

    await expect(response.text()).resolves.toContain('Workspace connected');
    expect(mockUpsertTeamsInstallation).not.toHaveBeenCalled();
    expect(mockLinkKiloUser).toHaveBeenCalled();
  });

  it('rejects organization installs from non-owner roles', async () => {
    mockLimit.mockResolvedValue([]);
    mockGetUserOrganizationsWithSeats.mockResolvedValue([
      { organizationId: 'org-1', organizationName: 'Example Org', role: 'member' },
    ]);

    const response = await POST(
      new Request('http://localhost:3000/api/chat/install-integration', {
        method: 'POST',
        body: new URLSearchParams({ token: buildToken(), owner: 'org:org-1' }),
      })
    );

    expect(response.status).toBe(403);
    expect(mockUpsertTeamsInstallation).not.toHaveBeenCalled();
    expect(mockLinkKiloUser).not.toHaveBeenCalled();
  });
});
