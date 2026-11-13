import { timingSafeEqual } from '@kilocode/encryption';
import type * as EncryptionModule from '@kilocode/encryption';
import { validateAdminSecret } from './admin-auth';

jest.mock('@kilocode/encryption', () => {
  const actual = jest.requireActual<typeof EncryptionModule>('@kilocode/encryption');
  return {
    ...actual,
    timingSafeEqual: jest.fn(actual.timingSafeEqual),
  };
});

const mockedTimingSafeEqual = timingSafeEqual as jest.MockedFunction<typeof timingSafeEqual>;

const SECRET = 'local-test-admin-secret-value';

// Same length as SECRET so a length-insensitive comparison is exercised too.
const SAME_LENGTH_WRONG_SECRET = 'local-test-admin-secret-VALUE';

describe('validateAdminSecret', () => {
  beforeEach(() => {
    mockedTimingSafeEqual.mockClear();
  });

  it('accepts a header that matches the stored secret', () => {
    expect(validateAdminSecret(SECRET, SECRET)).toEqual({ success: true });
  });

  it('accepts a non-ASCII secret when both sides match', () => {
    const secret = 'sécrèt-admin-秘密';
    expect(validateAdminSecret(secret, secret)).toEqual({ success: true });
  });

  it('rejects a same-length header that differs by a single character', () => {
    expect(validateAdminSecret(SAME_LENGTH_WRONG_SECRET, SECRET)).toEqual({
      success: false,
      error: 'Invalid admin secret',
    });
  });

  it('rejects a shorter header than the stored secret', () => {
    expect(validateAdminSecret('short', SECRET)).toEqual({
      success: false,
      error: 'Invalid admin secret',
    });
  });

  it('rejects a longer header than the stored secret', () => {
    expect(validateAdminSecret(`${SECRET}-extended`, SECRET)).toEqual({
      success: false,
      error: 'Invalid admin secret',
    });
  });

  it('rejects a header that repeats the stored secret', () => {
    expect(validateAdminSecret(`${SECRET}${SECRET}`, SECRET)).toEqual({
      success: false,
      error: 'Invalid admin secret',
    });
  });

  it('rejects a missing header', () => {
    expect(validateAdminSecret(null, SECRET)).toEqual({
      success: false,
      error: 'Missing X-Admin-Secret header',
    });
  });

  it('rejects an empty header', () => {
    expect(validateAdminSecret('', SECRET)).toEqual({
      success: false,
      error: 'Missing X-Admin-Secret header',
    });
  });

  it('rejects a non-empty header when the stored secret is empty', () => {
    expect(validateAdminSecret(SECRET, '')).toEqual({
      success: false,
      error: 'Invalid admin secret',
    });
  });

  it('reports an empty header as missing even when the stored secret is empty', () => {
    // An unset configured secret never matches: the empty header takes the missing-header
    // branch, so a blank admin secret cannot be claimed by sending a blank header.
    expect(validateAdminSecret('', '')).toEqual({
      success: false,
      error: 'Missing X-Admin-Secret header',
    });
  });

  it('compares through the shared timing-safe helper', () => {
    validateAdminSecret(SECRET, SECRET);
    expect(mockedTimingSafeEqual).toHaveBeenCalledWith(SECRET, SECRET);

    mockedTimingSafeEqual.mockClear();
    validateAdminSecret(SAME_LENGTH_WRONG_SECRET, SECRET);
    expect(mockedTimingSafeEqual).toHaveBeenCalledWith(SAME_LENGTH_WRONG_SECRET, SECRET);
  });

  it('does not compare through the shared helper when the header is absent', () => {
    validateAdminSecret(null, SECRET);
    validateAdminSecret('', SECRET);
    expect(mockedTimingSafeEqual).not.toHaveBeenCalled();
  });
});
