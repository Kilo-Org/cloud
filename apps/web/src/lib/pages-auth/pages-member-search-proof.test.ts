import { createSignedToken } from '@/lib/signed-token';
import { createPagesAuthCode } from './pages-auth-code';
import {
  createPagesMemberSearchProof,
  isPagesMemberSearchProofFor,
} from './pages-member-search-proof';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-pages-member-search-secret',
}));

const NOW = new Date('2026-03-01T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const subject = { userId: 'user-1', audience: 'pages-dev' };

describe('pages-member-search-proof', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('a proof holds for the person and deployment it was minted for', () => {
    const proof = createPagesMemberSearchProof(subject);

    expect(isPagesMemberSearchProofFor(proof, subject)).toBe(true);
    expect(isPagesMemberSearchProofFor(proof, { ...subject, userId: 'user-2' })).toBe(false);
    expect(isPagesMemberSearchProofFor(proof, { ...subject, audience: 'pages' })).toBe(false);
  });

  test('a proof lasts one eight-hour Pages session', () => {
    const proof = createPagesMemberSearchProof(subject);

    jest.setSystemTime(NOW.getTime() + 8 * HOUR_MS);
    expect(isPagesMemberSearchProofFor(proof, subject)).toBe(true);

    jest.setSystemTime(NOW.getTime() + 8 * HOUR_MS + 1000);
    expect(isPagesMemberSearchProofFor(proof, subject)).toBe(false);
  });

  test('a Pages sign-in code is not a proof', () => {
    const code = createPagesAuthCode({ ...subject, state: 'A'.repeat(43) });

    expect(isPagesMemberSearchProofFor(code, subject)).toBe(false);
  });

  test('a token for another purpose, or a tampered proof, is not a proof', () => {
    const other = createSignedToken({ purpose: 'something-else', ...subject });
    const [payload, signature] = createPagesMemberSearchProof(subject).split('.');
    const forged = `${Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), userId: 'x' })
    ).toString('base64url')}.${signature}`;

    expect(isPagesMemberSearchProofFor(other, subject)).toBe(false);
    expect(isPagesMemberSearchProofFor(forged, { ...subject, userId: 'x' })).toBe(false);
  });
});
