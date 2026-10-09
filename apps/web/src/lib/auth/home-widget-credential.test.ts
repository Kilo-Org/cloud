import type {
  User,
  DeviceSession,
  DeviceRefreshToken,
  Organization,
  OrganizationMembership,
} from '@kilocode/db/schema';
import jwt from 'jsonwebtoken';
import { getResourceDelegationAuthority } from './resource-delegation';
import { validateAuthorizationHeader } from '@kilocode/web-shared/lib/tokens';
import {
  authenticateHomeWidget,
  issueHomeWidgetCredential,
  HOME_WIDGET_AUDIENCE,
  HOME_WIDGET_CREDENTIAL_SECONDS,
} from './home-widget-credential';

jest.mock('./resource-delegation', () => ({ getResourceDelegationAuthority: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'widget-contract-test-secret',
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    query: {
      kilocode_users: { findFirst: jest.fn() },
      device_sessions: { findFirst: jest.fn() },
      device_refresh_tokens: { findFirst: jest.fn() },
      organizations: { findFirst: jest.fn() },
      organization_memberships: { findFirst: jest.fn() },
    },
  },
}));
import { db } from '@kilocode/web-shared/lib/drizzle';

const user = {
  id: 'oauth/widget-user',
  api_token_pepper: 'current-pepper',
  blocked_at: null,
  blocked_reason: null,
} as User;
const organizationId = '11111111-1111-4111-8111-111111111111';
const deviceSessionId = '22222222-2222-4222-8222-222222222222';
const authority = jest.mocked(getResourceDelegationAuthority);
const currentUser = jest.mocked(db.query.kilocode_users.findFirst);
const session = jest.mocked(db.query.device_sessions.findFirst);
const refresh = jest.mocked(db.query.device_refresh_tokens.findFirst);
const organization = jest.mocked(db.query.organizations.findFirst);
const membership = jest.mocked(db.query.organization_memberships.findFirst);

function headers(token: string): Headers {
  return new Headers({ Authorization: `Bearer ${token}` });
}

beforeEach(() => {
  jest.clearAllMocks();
  currentUser.mockResolvedValue(user);
  session.mockResolvedValue({ id: deviceSessionId } as DeviceSession);
  refresh.mockResolvedValue({ token_hash: 'unconsumed' } as DeviceRefreshToken);
  organization.mockResolvedValue({ id: organizationId } as Organization);
  membership.mockResolvedValue({ organization_id: organizationId } as OrganizationMembership);
  authority.mockResolvedValue({
    user,
    credentialKind: 'device-access',
    deviceSessionId,
    isModern: false,
    runtimeAdmission: {
      source: 'user',
      authorizationUserId: user.id,
      authorizationPepper: user.api_token_pepper,
    },
  });
});

describe('dedicated Home widget credential', () => {
  it('binds verified device/account/org authority, lasts thirty days, and cannot authorize ordinary APIs', async () => {
    const requestHeaders = headers('source-access-token');
    const issued = await issueHomeWidgetCredential(user, organizationId, requestHeaders);
    expect(authority).toHaveBeenCalledWith(user, { headers: requestHeaders, organizationId });
    const claims = jwt.verify(issued.token, 'widget-contract-test-secret', {
      audience: HOME_WIDGET_AUDIENCE,
    });
    expect(claims).toMatchObject({
      widgetUserId: user.id,
      deviceSessionId,
      organizationId,
      tokenPurpose: 'home-widget',
    });
    if (typeof claims === 'string' || claims.exp === undefined || claims.iat === undefined)
      throw new Error('claims missing');
    expect(claims.exp - claims.iat).toBe(HOME_WIDGET_CREDENTIAL_SECONDS);
    expect(issued.expiresAt).toBe(claims.exp * 1000);
    expect(await authenticateHomeWidget(headers(issued.token))).toEqual({
      userId: user.id,
      organizationId,
    });
    expect(validateAuthorizationHeader(headers(issued.token))).toHaveProperty('error');
  });

  it('refuses browser or human API principals without a native device session', async () => {
    authority.mockResolvedValue({
      user,
      credentialKind: 'human-api',
      isModern: false,
      runtimeAdmission: {
        source: 'user',
        authorizationUserId: user.id,
        authorizationPepper: user.api_token_pepper,
      },
    });
    await expect(issueHomeWidgetCredential(user, null, new Headers())).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it.each([
    'user missing',
    'blocked',
    'pepper rotated',
    'session revoked',
    'session expired',
    'org removed',
    'membership removed',
  ])('rejects %s on every read', async failure => {
    const issued = await issueHomeWidgetCredential(user, organizationId);
    if (failure === 'user missing') currentUser.mockResolvedValue(undefined);
    if (failure === 'blocked')
      currentUser.mockResolvedValue({ ...user, blocked_reason: 'blocked' });
    if (failure === 'pepper rotated')
      currentUser.mockResolvedValue({ ...user, api_token_pepper: 'rotated' });
    if (failure === 'session revoked') session.mockResolvedValue(undefined);
    if (failure === 'session expired') refresh.mockResolvedValue(undefined);
    if (failure === 'org removed') organization.mockResolvedValue(undefined);
    if (failure === 'membership removed') membership.mockResolvedValue(undefined);
    await expect(authenticateHomeWidget(headers(issued.token))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it.each(['wrong audience', 'wrong environment', 'expired', 'future issuance', 'wrong signature'])(
    'rejects %s before database access',
    async failure => {
      const issued = await issueHomeWidgetCredential(user, null);
      const claims = jwt.verify(issued.token, 'widget-contract-test-secret');
      if (typeof claims === 'string') throw new Error('claims missing');
      if (failure === 'wrong audience') claims.aud = 'kilo-api';
      if (failure === 'wrong environment') claims.env = 'other-environment';
      if (failure === 'expired') claims.exp = Math.floor(Date.now() / 1000) - 1;
      if (failure === 'future issuance') claims.iat = Math.floor(Date.now() / 1000) + 60;
      const token = jwt.sign(
        claims,
        failure === 'wrong signature' ? 'wrong-secret' : 'widget-contract-test-secret'
      );
      currentUser.mockClear();
      await expect(authenticateHomeWidget(headers(token))).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      expect(currentUser).not.toHaveBeenCalled();
    }
  );
});
