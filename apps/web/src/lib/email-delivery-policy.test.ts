import {
  getEmailVerificationRecipient,
  resolveOutboundEmailMode,
  routeOutboundEmail,
} from '@/lib/email-delivery-policy';

const message = {
  to: 'customer@external.example',
  subject: 'Sign in to Kilo Code',
  html: '<p>Sign in</p>',
  replyTo: 'supporter@external.example',
  category: 'magicLink',
};

describe('outbound email delivery policy', () => {
  it('allows unrestricted delivery only for the production target', () => {
    expect(resolveOutboundEmailMode({ VERCEL_TARGET_ENV: 'production' })).toEqual({
      kind: 'live',
    });
    expect(routeOutboundEmail(message, { VERCEL_TARGET_ENV: 'production' })).toEqual({
      kind: 'mailgun',
      mode: 'live',
      params: message,
    });
  });

  it('redirects staging delivery to an internal sink', () => {
    const environment = {
      VERCEL_TARGET_ENV: 'staging',
      STAGING_EMAIL_REDIRECT_TO: 'staging-email@kilocode.ai',
    };

    expect(getEmailVerificationRecipient(message.to, environment)).toBe(
      'staging-email@kilocode.ai'
    );
    expect(routeOutboundEmail(message, environment)).toEqual({
      kind: 'mailgun',
      mode: 'redirect',
      params: {
        ...message,
        to: 'staging-email@kilocode.ai',
        subject: '[STAGING to: customer@external.example] Sign in to Kilo Code',
        replyTo: 'staging-email@kilocode.ai',
      },
    });
  });

  it.each([
    undefined,
    '',
    'staging@example.com',
    'staging@subdomain.kilocode.ai',
    'staging@kilocode.ai.example.com',
    'first@kilocode.ai,second@kilocode.ai',
  ])('fails closed when the staging sink is unsafe: %s', sink => {
    expect(() =>
      resolveOutboundEmailMode({
        VERCEL_TARGET_ENV: 'staging',
        STAGING_EMAIL_REDIRECT_TO: sink,
      })
    ).toThrow(
      'STAGING_EMAIL_REDIRECT_TO must contain exactly one valid @kilocode.ai email address'
    );
  });

  it.each(['preview', 'development', 'qa'])('suppresses the %s Vercel target', target => {
    expect(routeOutboundEmail(message, { VERCEL_TARGET_ENV: target })).toEqual({
      kind: 'suppressed',
      targetEnvironment: target,
    });
    expect(getEmailVerificationRecipient(message.to, { VERCEL_TARGET_ENV: target })).toBeNull();
  });

  it('captures email locally when no Vercel target is present', () => {
    expect(routeOutboundEmail(message, { NODE_ENV: 'development' })).toEqual({
      kind: 'local_outbox',
      params: message,
    });
    expect(getEmailVerificationRecipient(message.to, { NODE_ENV: 'development' })).toBeNull();
  });

  it('fails an unclassified production process instead of writing a local outbox', () => {
    expect(routeOutboundEmail(message, { NODE_ENV: 'production' })).toEqual({
      kind: 'configuration_error',
    });
  });

  it('suppresses provider delivery in tests even when a live target leaks into the process', () => {
    const environment = { NODE_ENV: 'test', VERCEL_TARGET_ENV: 'production' };
    expect(routeOutboundEmail(message, environment)).toEqual({
      kind: 'suppressed',
      targetEnvironment: null,
    });
    expect(getEmailVerificationRecipient(message.to, environment)).toBe(message.to);
  });

  it('suppresses explicit automated-test deployments even in production mode', () => {
    const environment = {
      IS_IN_AUTOMATED_TEST: '1',
      NODE_ENV: 'production',
      VERCEL_TARGET_ENV: 'production',
    };
    expect(routeOutboundEmail(message, environment)).toEqual({
      kind: 'suppressed',
      targetEnvironment: null,
    });
  });

  it('removes line breaks from the intended recipient before adding it to the subject', () => {
    const route = routeOutboundEmail(
      { ...message, to: 'customer@example.com\r\nBcc: victim@example.com' },
      {
        VERCEL_TARGET_ENV: 'staging',
        STAGING_EMAIL_REDIRECT_TO: 'staging-email@kilocode.ai',
      }
    );

    expect(route).toMatchObject({
      kind: 'mailgun',
      params: {
        subject: '[STAGING to: customer@example.com Bcc: victim@example.com] Sign in to Kilo Code',
      },
    });
  });
});
