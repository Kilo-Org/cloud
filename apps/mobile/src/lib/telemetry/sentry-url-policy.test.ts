import { describe, expect, it } from 'vitest';

import { redactSharePaths, scrubUrl } from './sentry-url-policy';

describe('share-link redaction', () => {
  it.each([
    ['https://app.kilo.ai/s/fake.share.jwt', 'https://app.kilo.ai/s/[redacted]'],
    ['https://app.kilo.ai/share/fake-share-id/view', 'https://app.kilo.ai/share/[redacted]/view'],
    ['kiloapp:///shared/fake-share-token', 'kiloapp:///shared/[redacted]'],
    ['/(app)/shared/fake-share-token', '/(app)/shared/[redacted]'],
    ['Navigation to shared/fake-share-token', 'Navigation to shared/[redacted]'],
    ['https://app.kilo.ai/s/[redacted]', 'https://app.kilo.ai/s/[redacted]'],
  ])('redacts the credential in %s', (input, expected) => {
    expect(redactSharePaths(input)).toBe(expected);
  });

  it.each([
    'https://app.kilo.ai/sessions/abc',
    'https://app.kilo.ai/api/users/list',
    '/agent-chat/[session-id]',
  ])('keeps %s unchanged', input => {
    expect(redactSharePaths(input)).toBe(input);
  });

  it('strips the query before it redacts the share credential', () => {
    expect(scrubUrl('https://app.kilo.ai/s/fake.share.jwt?ref=fake-ref')).toBe(
      'https://app.kilo.ai/s/[redacted]'
    );
  });
});
