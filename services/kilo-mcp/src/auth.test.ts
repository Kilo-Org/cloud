import { describe, expect, it } from 'vitest';
import { forwardedAuthFromProps, ORGANIZATION_ID_HEADER } from './auth';

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
});
