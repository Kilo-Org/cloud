import {
  isPagesAuthClient,
  isPagesAuthOrigin,
  PAGES_AUTH_CALLBACK_PATH,
  pagesAuthCallbackUrl,
} from './pages-auth-clients';

// Production is configured; the dev deployment has no secret.
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  PAGES_AUTH_SECRET: 'p'.repeat(40),
  PAGES_DEV_AUTH_SECRET: '',
}));

const PAGES = 'https://pages.kiloapps.io';
const PAGES_DEV = 'https://pages-dev.kiloapps.io';
const SECRET = 'p'.repeat(40);

describe('pages-auth-clients', () => {
  test('a configured deployment may sign people in', () => {
    expect(isPagesAuthOrigin(PAGES)).toBe(true);
  });

  test('a deployment without a secret may not', () => {
    expect(isPagesAuthOrigin(PAGES_DEV)).toBe(false);
    expect(isPagesAuthClient(PAGES_DEV, '')).toBe(false);
    expect(isPagesAuthClient(PAGES_DEV, SECRET)).toBe(false);
  });

  test.each([
    'https://pages.kiloapps.io/',
    'https://pages.kiloapps.io/p/abc',
    'http://pages.kiloapps.io',
    'https://pages.kiloapps.io.evil.example',
    'https://evil.pages.kiloapps.io',
    'https://PAGES.kiloapps.io',
    'https://app.kilo.ai',
    '',
  ])('an origin that is not exactly a deployment is refused: %s', origin => {
    expect(isPagesAuthOrigin(origin)).toBe(false);
    expect(isPagesAuthClient(origin, SECRET)).toBe(false);
  });

  test('only the configured secret proves a deployment', () => {
    expect(isPagesAuthClient(PAGES, SECRET)).toBe(true);
    expect(isPagesAuthClient(PAGES, null)).toBe(false);
    expect(isPagesAuthClient(PAGES, '')).toBe(false);
    expect(isPagesAuthClient(PAGES, 'p'.repeat(39))).toBe(false);
    expect(isPagesAuthClient(PAGES, 'p'.repeat(41))).toBe(false);
    expect(isPagesAuthClient(PAGES, 'q'.repeat(40))).toBe(false);
  });

  test('the callback is the fixed path on the deployment, with the code and state', () => {
    const url = new URL(pagesAuthCallbackUrl(PAGES, { code: 'a.b', state: 'S'.repeat(43) }));

    expect(url.origin).toBe(PAGES);
    expect(url.pathname).toBe(PAGES_AUTH_CALLBACK_PATH);
    expect(Object.fromEntries(url.searchParams)).toEqual({ code: 'a.b', state: 'S'.repeat(43) });
  });
});
