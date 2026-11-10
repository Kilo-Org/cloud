import { describe, expect, it } from 'vitest';
import {
  BRIEFING_MAX_EXCERPT_BYTES,
  briefingHasActivity,
  briefingSourceSchema,
  briefingSummarySchema,
  redactBriefingExcerpt,
  redactBriefingExcerptOrDrop,
  redactBriefingTitle,
  truncateBriefingUtf8,
} from './agent-briefing';

describe('scheduled briefing contracts', () => {
  it('bounds multilingual excerpts by UTF8 bytes without broken characters', () => {
    const excerpt = redactBriefingExcerpt('界😀'.repeat(1000));
    expect(excerpt).toBe('界😀'.repeat(Math.floor(BRIEFING_MAX_EXCERPT_BYTES / 7)));
    expect(excerpt).not.toContain('\uFFFD');
    expect(truncateBriefingUtf8('a😀b', 4)).toBe('a');
    expect(truncateBriefingUtf8('a😀b', 5)).toBe('a😀');
  });
  it('redacts sensitive completed-response text before truncation', () => {
    const excerpt = redactBriefingExcerpt(
      'token=secret-value person@example.com https://example.com/path?secret=value'
    );
    expect(excerpt).not.toContain('secret-value');
    expect(excerpt).not.toContain('person@example.com');
    expect(excerpt).not.toContain('?secret');
  });
  it('rejects cost evidence and obsolete regeneration states', () => {
    expect(
      briefingSourceSchema.safeParse({
        id: 'cost',
        sessionId: 'ses_test',
        kind: 'cost',
        title: 'Cost',
        url: '/session',
        occurredAt: '2026-10-28T08:00:00.000Z',
      }).success
    ).toBe(false);
    expect(briefingSummarySchema.shape.status.safeParse('outdated').success).toBe(false);
    expect(briefingHasActivity({ sessions: 0, pullRequests: 0, blockers: 0 })).toBe(false);
  });
});

describe('briefing evidence screening', () => {
  const secretKey = 'wJalrXUtnFEMI/' + 'K7MDENG/bPxRfiCYEXAMPLEKEY';
  const accessKeyId = 'AKIA' + 'IOSFODNN7EXAMPL3';
  const googleKey = 'AIza' + 'SyA1234567890abcdefghijklmnopqrstuv';
  const hexKey = '8f7a3b2c' + '1d4e5f60' + '718293a4' + 'b5c6d7e8';
  const signedValue = [
    'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0',
    'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ].join('.');

  it('screens an assigned value whose key name joins credential words with separators', () => {
    const text = redactBriefingExcerpt('AWS_SECRET_' + `ACCESS_KEY=${secretKey}`);
    expect(text).not.toContain(secretKey);
    expect(text).toContain('[redacted credential]');
  });

  it('screens quoted values and hyphenated key names', () => {
    const quoted = redactBriefingExcerpt(`client_secret: "${'abc' + '123' + 'xyz'}"`);
    expect(quoted).toContain('[redacted credential]');
    expect(quoted).not.toContain('abc123xyz');
    const header = redactBriefingExcerpt(`X-API-KEY: ${'header' + 'value'}`);
    expect(header).toContain('[redacted credential]');
    expect(header).not.toContain('headervalue');
    expect(
      redactBriefingExcerpt('curl -H "Authorization: Bearer ' + 'abc.def' + '" https://x.test/a')
    ).toBe('curl -H "Authorization: [redacted credential]" https://x.test/a');
  });

  it('screens credential value shapes that appear without a key name', () => {
    for (const value of [accessKeyId, googleKey, hexKey, signedValue]) {
      const text = redactBriefingExcerpt(`Observed ${value} in the transcript.`);
      expect(text).not.toContain(value);
    }
  });

  it('keeps evidence that carries no credential material', () => {
    const evidence =
      'Plan: 2 of 3 steps done; agent_briefing_snapshots updated after commit 9f2c1a8.';
    expect(redactBriefingExcerpt(evidence)).toBe(evidence);
    expect(redactBriefingExcerpt('Turnkey: 4 files changed.')).toBe('Turnkey: 4 files changed.');
  });

  it('screens every pair of a joined assignment', () => {
    const body = redactBriefingExcerpt('user=' + 'bob&' + 'password=' + 'hunter2');
    expect(body).not.toContain('hunter2');
    expect(body).toContain('[redacted credential]');
    expect(redactBriefingExcerptOrDrop('user=' + 'bob&' + 'password=' + 'hunter2')).not.toContain(
      'hunter2'
    );
  });

  it('screens a punctuated value as a whole', () => {
    for (const separator of ['?', '|', ')']) {
      const text = 'password=' + 'p@ss' + separator + 'word more';
      expect(redactBriefingExcerpt(text)).toBe('[redacted credential] more');
      expect(redactBriefingExcerptOrDrop(text)).toBe('[redacted credential] more');
    }
  });

  it('screens an authentication scheme with its payload', () => {
    const header = 'curl -H "Authorization: Basic ' + 'dXNlcjpwYXNz' + '" https://x.test/a';
    expect(redactBriefingExcerpt(header)).toBe('curl -H "[redacted credential]" https://x.test/a');
    expect(redactBriefingExcerptOrDrop(header)).toBe(
      'curl -H "[redacted credential]" https://x.test/a'
    );
  });

  it('screens a credential flag with its argument', () => {
    const redacted = '[redacted credential]';
    const cases: Array<[string, string]> = [
      ['run --password ' + 'hunter' + '2', `run --password ${redacted}`],
      ['run --verbose --password ' + 'hunter' + '2', `run --verbose --password ${redacted}`],
      ['run -v --password ' + 'hunter' + '2', `run -v --password ${redacted}`],
      ['run --password -' + 'hunter' + '2', `run --password ${redacted}`],
      ['run --password --' + 'hunter' + '2', `run --password ${redacted}`],
      ['run --pass ' + 'hunter' + '2', `run --pass ${redacted}`],
    ];
    for (const [command, screened] of cases) {
      expect(redactBriefingExcerpt(command)).toBe(screened);
      expect(redactBriefingExcerptOrDrop(command)).toBe(screened);
    }
  });

  it('withholds an excerpt when a credential continues past its screened value', () => {
    const continuation = 'c2VjcmV0OnZhbHVlOjAxMjM0NTY3ODk=';
    const text = 'password=' + 'hunter' + ' ' + continuation;
    expect(redactBriefingExcerpt(text)).toBe('[redacted credential] ' + continuation);
    expect(redactBriefingExcerptOrDrop(text)).toBeUndefined();
  });

  it('keeps an excerpt whose remaining text is an ordinary pair, path or identifier', () => {
    for (const remainder of ['user=abc123', 'getUserById', 'deployment/app', '2024/11/03']) {
      expect(redactBriefingExcerptOrDrop('password=' + 'hunter' + ' ' + remainder)).toBe(
        '[redacted credential] ' + remainder
      );
    }
  });

  it('screens an opaque run that uses a single character class', () => {
    for (const value of ['1234567890'.repeat(5), 'abcdefghijklmnopqrstuvwxyz'.repeat(2)]) {
      const text = redactBriefingExcerpt(`Observed ${value} in the transcript.`);
      expect(text).not.toContain(value);
    }
  });

  it('screens a quoted key and its value', () => {
    const json = redactBriefingExcerpt('{"' + 'password' + '":"' + 'hunter2' + '"}');
    expect(json).not.toContain('hunter2');
    expect(redactBriefingExcerptOrDrop('{"' + 'password' + '":"' + 'hunter2' + '"}')).not.toContain(
      'hunter2'
    );
  });

  it('screens a credential word that ends an unseparated key name', () => {
    for (const key of ['MYSQL' + 'PASSWORD', 'my' + 'token']) {
      const text = redactBriefingExcerpt(`${key}=${'hunter' + '2'}`);
      expect(text).not.toContain('hunter' + '2');
    }
  });

  it('screens assigned values under prefixed credential key names', () => {
    for (const key of [
      'MYSQL_' + 'PWD',
      'DB_' + 'PASS',
      'REDIS_' + 'PASSPHRASE',
      'PG' + 'PWD',
      'PASS' + 'KEY',
      'pass' + 'key',
      'pg' + 'pass',
      'mongo' + 'pass',
      'oracle' + 'pass',
      'db' + 'pass',
      'db' + 'Pass',
      'mysql' + 'pwd',
      'redis' + 'passphrase',
      'passphrase',
      'pwd',
    ]) {
      const text = redactBriefingExcerpt(`${key}=${'hunter' + '2'}`);
      expect(text).not.toContain('hunter' + '2');
      expect(text).toContain('[redacted credential]');
    }
    expect(redactBriefingExcerptOrDrop('DB_' + 'PASS=' + 'hunter' + '2')).toBe(
      '[redacted credential]'
    );
  });

  it('keeps ordinary words that contain a credential word', () => {
    for (const evidence of [
      'Passage: open.',
      'Overpass: closed.',
      'Bypassed: the cache layer.',
      'Compass: north.',
    ]) {
      expect(redactBriefingExcerpt(evidence)).toBe(evidence);
    }
  });

  it('keeps ordinary keys that merely begin with a credential word', () => {
    for (const evidence of ['tokenizer=cl100k_base', 'keywords=[plan, test]', 'keyboard=us']) {
      expect(redactBriefingExcerpt(evidence)).toBe(evidence);
    }
  });

  it('screens a hyphenated opaque value', () => {
    const value = 'Ab3dEf6h-Ij1kLm4n-Op7qRs2t-Uv5wXy8z-Ab3dEf6h-Ij1kLm4n';
    const text = redactBriefingExcerpt(`Observed ${value} in the transcript.`);
    expect(text).not.toContain(value);
  });

  it('withholds an excerpt when screening still finds credential material', () => {
    expect(redactBriefingExcerptOrDrop('client_secret: "' + secretKey)).toBeUndefined();
    expect(redactBriefingExcerptOrDrop('Completed response with no credentials.')).toBe(
      'Completed response with no credentials.'
    );
  });

  it('screens a quoted value that contains an escaped quote', () => {
    const text = '{"password":"abc' + '\\"def' + 'SECRET"}';
    expect(redactBriefingExcerpt(text)).not.toContain('def' + 'SECRET');
    expect(redactBriefingExcerptOrDrop(text)).not.toContain('def' + 'SECRET');
  });

  it('screens a credential pair whose quotes are escaped', () => {
    const text = 'curl -d "{\\"password\\":\\"' + 'hunter' + '2\\"}" https://x.test/hook';
    expect(redactBriefingExcerpt(text)).toBe(
      'curl -d "{\\"[redacted credential]}" https://x.test/hook'
    );
    expect(redactBriefingExcerptOrDrop(text)).not.toContain('hunter' + '2');
    expect(redactBriefingTitle(text)).not.toContain('hunter' + '2');
  });

  it('screens titles with the excerpt rules and keeps a neutral title otherwise', () => {
    expect(redactBriefingTitle('Captured session')).toBe('Captured session');
    expect(redactBriefingTitle('Deploy ' + 'AWS_SECRET_ACCESS_KEY=' + secretKey)).toBe(
      'Deploy [redacted credential]'
    );
    expect(redactBriefingTitle('Plan for client_' + 'secret: "' + secretKey)).toBe('Agent session');
  });
});
