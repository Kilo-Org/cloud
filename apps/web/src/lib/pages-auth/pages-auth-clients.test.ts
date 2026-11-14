import {
  isPagesAuthClient,
  isPagesAuthAudience,
  PAGES_AUTH_CALLBACK_PATH,
  pagesAuthCallbackUrl,
} from './pages-auth-clients';

// Production is configured; the dev deployment has no secret.
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  PAGES_AUTH_SECRET: 'p'.repeat(40),
  PAGES_DEV_AUTH_SECRET: '',
}));

const PAGES = 'pages';
const PAGES_DEV = 'pages-dev';
const SECRET = 'p'.repeat(40);

describe('pages-auth-clients', () => {
  test('a configured deployment may sign people in', () => {
    expect(isPagesAuthAudience(PAGES)).toBe(true);
  });

  test('a deployment without a secret may not', () => {
    expect(isPagesAuthAudience(PAGES_DEV)).toBe(false);
    expect(isPagesAuthClient(PAGES_DEV, '')).toBe(false);
    expect(isPagesAuthClient(PAGES_DEV, SECRET)).toBe(false);
    expect(pagesAuthCallbackUrl(PAGES_DEV, { code: 'a.b', state: 'S'.repeat(43) })).toBeNull();
  });

  test.each(['https://pages.kiloapps.io', 'Pages', 'pages ', 'kilo-api', 'kilo-gateway', ''])(
    'an audience that is not exactly a deployment is refused: %s',
    audience => {
      expect(isPagesAuthAudience(audience)).toBe(false);
      expect(isPagesAuthClient(audience, SECRET)).toBe(false);
      expect(pagesAuthCallbackUrl(audience, { code: 'a.b', state: 'S'.repeat(43) })).toBeNull();
    }
  );

  test('only the configured secret proves a deployment', () => {
    expect(isPagesAuthClient(PAGES, SECRET)).toBe(true);
    expect(isPagesAuthClient(PAGES, null)).toBe(false);
    expect(isPagesAuthClient(PAGES, '')).toBe(false);
    expect(isPagesAuthClient(PAGES, 'p'.repeat(39))).toBe(false);
    expect(isPagesAuthClient(PAGES, 'p'.repeat(41))).toBe(false);
    expect(isPagesAuthClient(PAGES, 'q'.repeat(40))).toBe(false);
  });

  test('the callback is the fixed path on the deployment, with the code and state', () => {
    const url = new URL(
      pagesAuthCallbackUrl(PAGES, { code: 'a.b', state: 'S'.repeat(43) }) ?? 'invalid:'
    );

    expect(url.origin).toBe('https://pages.kiloapps.io');
    expect(url.pathname).toBe(PAGES_AUTH_CALLBACK_PATH);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code: 'a.b',
      state: 'S'.repeat(43),
    });
  });
});
