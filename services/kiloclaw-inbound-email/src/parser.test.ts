import { describe, expect, it } from 'vitest';
import { parseRawEmail } from './parser';

describe('parseRawEmail', () => {
  it('parses simple text emails', () => {
    const parsed = parseRawEmail(
      'Message-ID: <msg-1@example.com>\r\nFrom: Ada <ada@example.com>\r\nSubject: Hello\r\nContent-Type: text/plain\r\n\r\nBody text'
    );

    expect(parsed).toEqual({
      messageId: '<msg-1@example.com>',
      from: 'ada@example.com',
      subject: 'Hello',
      text: 'Body text',
    });
  });

  it('extracts the text/plain part from multipart emails', () => {
    const parsed = parseRawEmail(
      [
        'Message-ID: <msg-2@example.com>',
        'From: sender@example.com',
        'Subject: Multipart',
        'Content-Type: multipart/alternative; boundary="abc123"',
        '',
        '--abc123',
        'Content-Type: text/html',
        '',
        '<p>HTML</p>',
        '--abc123',
        'Content-Type: text/plain',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Hello=20world',
        '--abc123--',
      ].join('\r\n')
    );

    expect(parsed.text).toBe('Hello world');
  });

  it('decodes encoded subject words', () => {
    const parsed = parseRawEmail(
      'From: sender@example.com\r\nSubject: =?UTF-8?B?SGVsbG8gd29ybGQ=?=\r\n\r\nBody'
    );

    expect(parsed.subject).toBe('Hello world');
  });
});
