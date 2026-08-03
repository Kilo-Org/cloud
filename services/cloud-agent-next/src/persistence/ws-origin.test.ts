import { describe, expect, it } from 'vitest';
import { isAllowedStreamWebSocketOrigin } from './ws-origin.js';

describe('isAllowedStreamWebSocketOrigin', () => {
  it('permits null origin (non-browser client)', () => {
    expect(isAllowedStreamWebSocketOrigin(null, '')).toBe(true);
    expect(isAllowedStreamWebSocketOrigin(null, 'https://example.com')).toBe(true);
  });

  it("permits 'null' origin (e.g. sandboxed iframe)", () => {
    expect(isAllowedStreamWebSocketOrigin('null', '')).toBe(true);
    expect(isAllowedStreamWebSocketOrigin('null', 'https://example.com')).toBe(true);
  });

  it('permits all origins when allowlist is empty', () => {
    expect(isAllowedStreamWebSocketOrigin('https://any-origin.com', '')).toBe(true);
  });

  it('permits an explicitly allowlisted https origin', () => {
    expect(
      isAllowedStreamWebSocketOrigin('https://cloud.kilocode.com', 'https://cloud.kilocode.com')
    ).toBe(true);
  });

  it('permits a listed origin among multiple entries', () => {
    expect(
      isAllowedStreamWebSocketOrigin(
        'https://staging.kilocode.com',
        'https://cloud.kilocode.com, https://staging.kilocode.com'
      )
    ).toBe(true);
  });

  it('rejects an unlisted https origin when allowlist is non-empty', () => {
    expect(isAllowedStreamWebSocketOrigin('https://evil.com', 'https://cloud.kilocode.com')).toBe(
      false
    );
  });

  it('permits a chrome-extension:// origin even when not in the allowlist', () => {
    expect(
      isAllowedStreamWebSocketOrigin('chrome-extension://abc123def', 'https://cloud.kilocode.com')
    ).toBe(true);
  });

  it('permits a moz-extension:// origin even when not in the allowlist', () => {
    expect(
      isAllowedStreamWebSocketOrigin('moz-extension://ff-uuid-here', 'https://cloud.kilocode.com')
    ).toBe(true);
  });

  it('permits extension origins with any UUID-like path', () => {
    expect(
      isAllowedStreamWebSocketOrigin(
        'chrome-extension://lkjasdf098234lkasjdf',
        'https://cloud.kilocode.com'
      )
    ).toBe(true);
    expect(
      isAllowedStreamWebSocketOrigin(
        'moz-extension://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        'https://cloud.kilocode.com'
      )
    ).toBe(true);
  });

  it('rejects an unknown scheme origin when allowlist is non-empty', () => {
    expect(
      isAllowedStreamWebSocketOrigin('http://cloud.kilocode.com', 'https://cloud.kilocode.com')
    ).toBe(false);
  });
});
