import { describe, expect, it } from 'vitest';
import { parseRawEmail, stableMessageId } from './parser';

describe('parseRawEmail', () => {
  it('parses simple text emails', async () => {
    const parsed = await parseRawEmail(
      'Message-ID: <msg-1@example.com>\r\nFrom: Ada <ada@example.com>\r\nSubject: Hello\r\nContent-Type: text/plain\r\n\r\nBody text'
    );

    expect(parsed).toEqual({
      messageId: '<msg-1@example.com>',
      from: 'ada@example.com',
      subject: 'Hello',
      text: 'Body text',
    });
  });

  it('extracts the text/plain part from multipart emails', async () => {
    const parsed = await parseRawEmail(
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

  it('decodes encoded subject words', async () => {
    const parsed = await parseRawEmail(
      'From: sender@example.com\r\nSubject: =?UTF-8?B?SGVsbG8gd29ybGQ=?=\r\n\r\nBody'
    );

    expect(parsed.subject).toBe('Hello world');
  });

  it('returns null when no sender header exists', async () => {
    const parsed = await parseRawEmail('Subject: Missing sender\r\n\r\nBody');

    expect(parsed.from).toBeNull();
  });

  it('falls back to html content when no text part exists', async () => {
    const parsed = await parseRawEmail(
      [
        'Received: from smtp.example.com (127.0.0.1)',
        '        by cloudflare-email.com (unknown) id 4fwwffRXOpyR',
        '        for <ki-e7e9395338874489839efdad131e6c16@kiloclaw.ai>; Tue, 27 Aug 2024 15:50:20 +0000',
        'From: "John" <remon@kilocode.ai>',
        'Reply-To: remon@kilocode.ai',
        'To: ki-e7e9395338874489839efdad131e6c16@kiloclaw.ai',
        'Subject: Testing Email Workers Local Dev',
        'Content-Type: text/html; charset="windows-1252"',
        'X-Mailer: Curl',
        'Date: Tue, 27 Aug 2024 08:49:44 -0700',
        'Message-ID: 2',
        '',
        'Hi there',
      ].join('\r\n')
    );

    expect(parsed.text).toBe('Hi there');
  });

  it('converts html fallback bodies to markdown', async () => {
    const parsed = await parseRawEmail(
      [
        'From: sender@example.com',
        'Subject: HTML fallback',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Tom &amp; Jerry&nbsp;<a href="https://example.com">link</a> <img src="https://example.com/cat.png" alt="cat"></p>',
      ].join('\r\n')
    );

    expect(parsed.text).toBe('Tom & Jerry [link](https://example.com) https://example.com/cat.png');
  });

  it('extracts nested multipart text without attachment bodies', async () => {
    const parsed = await parseRawEmail(
      [
        'From: sender@example.com',
        'Subject: Nested',
        'Content-Type: multipart/mixed; boundary="mixed"',
        '',
        '--mixed',
        'Content-Type: multipart/alternative; boundary="alt"',
        '',
        '--alt',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Plain body',
        '--alt',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>HTML body</p>',
        '--alt--',
        '--mixed',
        'Content-Type: text/plain; name="notes.txt"',
        'Content-Disposition: attachment; filename="notes.txt"',
        '',
        'Attachment text',
        '--mixed--',
      ].join('\r\n')
    );

    expect(parsed.text).toBe('Plain body');
  });

  it('accepts raw byte input for non-utf8 charsets', async () => {
    const raw = new Uint8Array([
      ...new TextEncoder().encode(
        'From: sender@example.com\r\nSubject: Charset\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nOl'
      ),
      0xe1,
    ]);

    const parsed = await parseRawEmail(raw);

    expect(parsed.text).toBe('Olá');
  });
});

describe('stableMessageId', () => {
  it('hashes raw bytes consistently', async () => {
    const raw = new Uint8Array([0x66, 0x6f, 0x6f]);

    await expect(stableMessageId(raw)).resolves.toBe(
      'sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae'
    );
  });
});
