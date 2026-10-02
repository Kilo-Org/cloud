const writeEmailToLocalOutboxMock = jest.fn<Promise<string>, [unknown]>(
  async () => '/repo/dev/logs/emails/message.html'
);
const captureMessageMock = jest.fn();

jest.mock('mailgun.js', () =>
  jest.fn().mockImplementation(() => ({
    client: jest.fn(() => ({
      messages: { create: jest.fn(async () => ({})) },
    })),
  }))
);
jest.mock('form-data', () => jest.fn());
jest.mock('@/lib/config.server', () => ({
  MAILGUN_API_KEY: 'test-mailgun-key',
  MAILGUN_DOMAIN: 'mail.example.test',
}));
jest.mock('@/lib/email-local-outbox', () => ({
  writeEmailToLocalOutbox: (params: unknown) => writeEmailToLocalOutboxMock(params),
}));
jest.mock('@sentry/nextjs', () => ({
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
}));

import Mailgun from 'mailgun.js';
import { getEmailVerificationRecipient, sendViaMailgun } from '@/lib/email-mailgun';

const mailgunConstructorMock = jest.mocked(Mailgun);
const mailgunInstance = mailgunConstructorMock.mock.results[0]?.value as {
  client: jest.Mock;
};
const mailgunClientMock = mailgunInstance.client;

function latestMessagesCreateMock(): jest.Mock {
  const client = mailgunClientMock.mock.results.at(-1)?.value as {
    messages?: { create?: jest.Mock };
  };
  if (!client?.messages?.create) throw new Error('Mailgun client was not constructed');
  return client.messages.create;
}

const originalAutomatedTest = process.env.IS_IN_AUTOMATED_TEST;
const originalNodeEnvironment = process.env.NODE_ENV;
const originalTargetEnvironment = process.env.VERCEL_TARGET_ENV;
const originalStagingSink = process.env.STAGING_EMAIL_REDIRECT_TO;

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

beforeEach(() => {
  delete process.env.IS_IN_AUTOMATED_TEST;
});

afterEach(() => {
  restoreEnvironmentVariable('IS_IN_AUTOMATED_TEST', originalAutomatedTest);
  restoreEnvironmentVariable('NODE_ENV', originalNodeEnvironment);
  restoreEnvironmentVariable('VERCEL_TARGET_ENV', originalTargetEnvironment);
  restoreEnvironmentVariable('STAGING_EMAIL_REDIRECT_TO', originalStagingSink);
  mailgunClientMock.mockClear();
  writeEmailToLocalOutboxMock.mockClear();
  captureMessageMock.mockClear();
});

const message = {
  to: 'customer@example.com',
  subject: 'Transactional message',
  html: '<p>Hello</p>',
  replyTo: 'customer@example.com',
  category: 'testTemplate',
};

describe('Mailgun email boundary', () => {
  it('delivers the original message in the production target', async () => {
    restoreEnvironmentVariable('NODE_ENV', 'production');
    process.env.VERCEL_TARGET_ENV = 'production';

    expect(getEmailVerificationRecipient(message.to)).toBe(message.to);
    await expect(sendViaMailgun(message)).resolves.toBe(true);

    expect(latestMessagesCreateMock()).toHaveBeenCalledWith('mail.example.test', {
      from: 'Kilo Code <hi@app.kilocode.ai>',
      'h:Reply-To': 'customer@example.com',
      to: 'customer@example.com',
      subject: 'Transactional message',
      html: '<p>Hello</p>',
    });
  });

  it('never gives Mailgun the external staging recipient or Reply-To', async () => {
    restoreEnvironmentVariable('NODE_ENV', 'production');
    process.env.VERCEL_TARGET_ENV = 'staging';
    process.env.STAGING_EMAIL_REDIRECT_TO = 'staging-email@kilocode.ai';

    expect(getEmailVerificationRecipient(message.to)).toBe('staging-email@kilocode.ai');
    await expect(sendViaMailgun(message)).resolves.toBe(true);

    expect(latestMessagesCreateMock()).toHaveBeenCalledWith('mail.example.test', {
      from: 'Kilo Code <hi@app.kilocode.ai>',
      'h:Reply-To': 'staging-email@kilocode.ai',
      to: 'staging-email@kilocode.ai',
      subject: '[STAGING to: customer@example.com] Transactional message',
      html: '<p>Hello</p>',
    });
  });

  it.each([
    undefined,
    '',
    'staging@example.com',
    'staging@subdomain.kilocode.ai',
    'staging@kilocode.ai.example.com',
    'first@kilocode.ai,second@kilocode.ai',
  ])('fails closed before Mailgun when the staging sink is unsafe: %s', async sink => {
    restoreEnvironmentVariable('NODE_ENV', 'production');
    process.env.VERCEL_TARGET_ENV = 'staging';
    restoreEnvironmentVariable('STAGING_EMAIL_REDIRECT_TO', sink);

    await expect(sendViaMailgun(message)).rejects.toThrow('STAGING_EMAIL_REDIRECT_TO');
    expect(mailgunClientMock).not.toHaveBeenCalled();
  });

  it('removes line breaks from the intended recipient in the staging subject', async () => {
    restoreEnvironmentVariable('NODE_ENV', 'production');
    process.env.VERCEL_TARGET_ENV = 'staging';
    process.env.STAGING_EMAIL_REDIRECT_TO = 'staging-email@kilocode.ai';

    await sendViaMailgun({
      ...message,
      to: 'customer@example.com\r\nBcc: victim@example.com',
    });

    expect(latestMessagesCreateMock()).toHaveBeenCalledWith(
      'mail.example.test',
      expect.objectContaining({
        subject: '[STAGING to: customer@example.com Bcc: victim@example.com] Transactional message',
      })
    );
  });

  it('captures local messages without constructing a Mailgun client', async () => {
    delete process.env.VERCEL_TARGET_ENV;
    restoreEnvironmentVariable('NODE_ENV', 'development');

    expect(getEmailVerificationRecipient(message.to)).toBeNull();
    await expect(sendViaMailgun(message)).resolves.toBe(true);

    expect(writeEmailToLocalOutboxMock).toHaveBeenCalledWith(message);
    expect(mailgunClientMock).not.toHaveBeenCalled();
  });

  it('suppresses tests even when they inherit the production target', async () => {
    restoreEnvironmentVariable('NODE_ENV', 'test');
    process.env.VERCEL_TARGET_ENV = 'production';

    expect(getEmailVerificationRecipient(message.to)).toBe(message.to);
    await expect(sendViaMailgun(message)).resolves.toBe(true);

    expect(writeEmailToLocalOutboxMock).not.toHaveBeenCalled();
    expect(mailgunClientMock).not.toHaveBeenCalled();
  });

  it('suppresses explicit automated-test deployments in the production target', async () => {
    restoreEnvironmentVariable('IS_IN_AUTOMATED_TEST', '1');
    restoreEnvironmentVariable('NODE_ENV', 'production');
    process.env.VERCEL_TARGET_ENV = 'production';

    await expect(sendViaMailgun(message)).resolves.toBe(true);

    expect(writeEmailToLocalOutboxMock).not.toHaveBeenCalled();
    expect(mailgunClientMock).not.toHaveBeenCalled();
  });

  it('fails production processes whose Vercel target is missing', async () => {
    restoreEnvironmentVariable('NODE_ENV', 'production');
    delete process.env.VERCEL_TARGET_ENV;

    await expect(sendViaMailgun(message)).resolves.toBe(false);

    expect(writeEmailToLocalOutboxMock).not.toHaveBeenCalled();
    expect(mailgunClientMock).not.toHaveBeenCalled();
    expect(captureMessageMock).toHaveBeenCalledWith(
      'VERCEL_TARGET_ENV is required for production email delivery',
      { level: 'error', tags: { source: 'email_service' } }
    );
  });

  it.each(['preview', 'development', 'qa'])(
    'suppresses %s without calling Mailgun',
    async target => {
      restoreEnvironmentVariable('NODE_ENV', 'production');
      process.env.VERCEL_TARGET_ENV = target;

      expect(getEmailVerificationRecipient(message.to)).toBeNull();
      await expect(sendViaMailgun(message)).resolves.toBe(true);

      expect(writeEmailToLocalOutboxMock).not.toHaveBeenCalled();
      expect(mailgunClientMock).not.toHaveBeenCalled();
    }
  );
});
