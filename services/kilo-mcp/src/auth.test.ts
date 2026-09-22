import { describe, expect, it } from 'vitest';
import { forwardedAuthFromProps, ORGANIZATION_ID_HEADER } from './auth';
import type { GrantProps } from './types';

describe('auth (props-derived identity)', () => {
  it('names the organization header apps/web reads', () => {
    expect(ORGANIZATION_ID_HEADER).toBe('x-kilocode-organizationid');
  });

  it('forwards the grant Kilo token and organization as a bearer + org header value', () => {
    const auth = forwardedAuthFromProps({
      kiloUserId: 'user-1',
      organizationId: 'org-uuid-1',
      kiloToken: 'kilo-tok',
      clientId: 'client-1',
    });
    expect(auth).toEqual({
      authorization: 'Bearer kilo-tok',
      organizationId: 'org-uuid-1',
      kiloUserId: 'user-1',
      clientId: 'client-1',
      adminEnabled: false,
      adminEligible: false,
    });
  });

  it('omits the organization for a personal grant (a caller header is never consulted)', () => {
    const auth = forwardedAuthFromProps({
      kiloUserId: 'user-1',
      organizationId: null,
      kiloToken: 'kilo-tok',
      clientId: 'client-1',
    });
    expect(auth.organizationId).toBeUndefined();
    expect(auth.authorization).toBe('Bearer kilo-tok');
  });

  it('forwards the admin opt-in when the grant props carry it', () => {
    const auth = forwardedAuthFromProps({
      kiloUserId: 'user-1',
      organizationId: null,
      kiloToken: 'kilo-tok',
      clientId: 'client-1',
      adminEnabled: true,
    });
    expect(auth.adminEnabled).toBe(true);
  });

  it('fails closed for a grant issued before the admin opt-in existed', () => {
    const auth = forwardedAuthFromProps({
      kiloUserId: 'user-1',
      organizationId: null,
      kiloToken: 'kilo-tok',
      clientId: 'client-1',
    });
    expect(auth.adminEnabled).toBe(false);
  });

  it('fails closed when the grant opted out', () => {
    const auth = forwardedAuthFromProps({
      kiloUserId: 'user-1',
      organizationId: null,
      kiloToken: 'kilo-tok',
      clientId: 'client-1',
      adminEnabled: false,
    });
    expect(auth.adminEnabled).toBe(false);
  });

  it('forwards the admin eligibility the grant carries', () => {
    const auth = forwardedAuthFromProps({
      kiloUserId: 'user-1',
      organizationId: null,
      kiloToken: 'kilo-tok',
      clientId: 'client-1',
      adminEligible: true,
    });
    expect(auth.adminEligible).toBe(true);
  });

  it('fails closed for admin eligibility: absent and non-true stay false', () => {
    for (const props of [
      { adminEligible: undefined },
      { adminEligible: false },
      // A pre-feature grant carries no adminEligible key at all.
      {},
    ] as Array<Pick<GrantProps, 'adminEligible'>>) {
      const auth = forwardedAuthFromProps({
        kiloUserId: 'user-1',
        organizationId: null,
        kiloToken: 'kilo-tok',
        clientId: 'client-1',
        ...props,
      });
      expect(auth.adminEligible).toBe(false);
    }
  });

  it('forwards the grant connection id the protected tools bind a request to', () => {
    const auth = forwardedAuthFromProps({
      kiloUserId: 'user-1',
      organizationId: null,
      kiloToken: 'kilo-tok',
      clientId: 'client-1',
      sessionId: 'sess-1',
    });
    expect(auth.sessionId).toBe('sess-1');
  });

  it('omits the connection id when the grant carries none or an empty one', () => {
    for (const sessionId of [undefined, '']) {
      const auth = forwardedAuthFromProps({
        kiloUserId: 'user-1',
        organizationId: null,
        kiloToken: 'kilo-tok',
        clientId: 'client-1',
        sessionId,
      });
      expect(auth.sessionId).toBeUndefined();
      expect('sessionId' in auth).toBe(false);
    }
  });
});
