import {
  createDeviceAuthViewerToken,
  verifyDeviceAuthViewerToken,
} from '@/lib/device-auth/device-auth-viewer-token';
import { createSignedToken } from '@/lib/signed-token';
import { createPagesAuthCode, verifyPagesAuthCode } from './pages-auth-code';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-pages-auth-code-secret',
}));

const NOW = new Date('2026-03-01T12:00:00.000Z');
const grant = {
  userId: 'user-1',
  audience: 'pages',
  state: 'A'.repeat(43),
};

describe('pages-auth-code', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('a code verifies to the grant it was minted for', () => {
    expect(verifyPagesAuthCode(createPagesAuthCode(grant))).toEqual(grant);
  });

  test('a code is good for a minute and no longer', () => {
    const code = createPagesAuthCode(grant);

    jest.setSystemTime(new Date(NOW.getTime() + 60_000));
    expect(verifyPagesAuthCode(code)).toEqual(grant);

    jest.setSystemTime(new Date(NOW.getTime() + 61_000));
    expect(verifyPagesAuthCode(code)).toBeNull();
  });

  test('a missing or tampered code is refused', () => {
    const code = createPagesAuthCode(grant);
    const tampered = code.slice(0, -1) + (code.at(-1) === 'a' ? 'b' : 'a');

    expect(verifyPagesAuthCode(null)).toBeNull();
    expect(verifyPagesAuthCode('')).toBeNull();
    expect(verifyPagesAuthCode('not-a-code')).toBeNull();
    expect(verifyPagesAuthCode(tampered)).toBeNull();
  });

  test('a signed token minted for another purpose is not a Pages code', () => {
    expect(verifyPagesAuthCode(createDeviceAuthViewerToken('ABCD-EFGH', 'user-1'))).toBeNull();
    expect(verifyPagesAuthCode(createSignedToken({ ...grant }))).toBeNull();
    expect(verifyPagesAuthCode(createSignedToken({ ...grant, purpose: 'other' }))).toBeNull();
  });

  test('a Pages code is not accepted as a device-auth viewer token', () => {
    expect(verifyDeviceAuthViewerToken(createPagesAuthCode(grant))).toBeNull();
  });

  test.each([
    { ...grant, userId: '' },
    { ...grant, audience: '' },
    { ...grant, state: 'short' },
    { ...grant, state: `${'A'.repeat(42)}/` },
    { ...grant, state: 7 },
  ])('a signed payload with an unusable field is refused: %j', payload => {
    const code = createSignedToken({ ...payload, purpose: 'pages-auth' });

    expect(verifyPagesAuthCode(code)).toBeNull();
  });
});
