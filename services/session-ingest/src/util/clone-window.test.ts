import { describe, expect, it } from 'vitest';

import type { CloneBatchRow } from '../dos/SessionIngestDO';
import { chainCloneRowDigest, cloneSourceDigestLine, cloneSourceRowBytes } from './clone-window';

function row(overrides: Partial<CloneBatchRow> = {}): CloneBatchRow {
  return {
    itemId: 'message/msg_01',
    itemType: 'message',
    itemData: '{"sessionID":"ses_a"}',
    itemDataR2Key: null,
    ingestedAt: 1,
    ...overrides,
  };
}

async function chainLines(lines: Array<string>): Promise<string> {
  let chain = '';
  for (const line of lines) chain = await chainCloneRowDigest(chain, line);
  return chain;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

describe('cloneSourceDigestLine', () => {
  it('uses the stored body for an inline row', () => {
    expect(cloneSourceDigestLine(row())).toBe('message/msg_01:message:{"sessionID":"ses_a"}');
  });

  it('uses the R2 key for an offloaded row', () => {
    expect(cloneSourceDigestLine(row({ itemData: '{}', itemDataR2Key: 'items/blob' }))).toBe(
      'message/msg_01:message:items/blob'
    );
  });
});

describe('cloneSourceRowBytes', () => {
  it('counts the identity and the inline body', () => {
    expect(cloneSourceRowBytes(row())).toBe(
      new TextEncoder().encode('message/msg_01').byteLength +
        new TextEncoder().encode('message').byteLength +
        new TextEncoder().encode('{"sessionID":"ses_a"}').byteLength
    );
  });

  it('skips the body of an offloaded row', () => {
    const offloaded = row({ itemData: '{}', itemDataR2Key: 'items/blob' });
    expect(cloneSourceRowBytes(offloaded)).toBeLessThan(cloneSourceRowBytes(row()));
  });
});

describe('chainCloneRowDigest', () => {
  it('hashes a single row line as the chain seed', async () => {
    const line = 'message/msg_01:message:{}';
    expect(await chainLines([line])).toBe(await sha256Hex(line));
  });

  it('is independent of how the rows are grouped', async () => {
    const lines = ['a:message:{}', 'b:message:{}', 'c:message:{}'];
    const prefix = await chainLines(lines.slice(0, 2));
    // Continuing from a saved prefix produces the same final value as one pass
    // over every line.
    expect(await chainLines(lines)).toBe(await chainCloneRowDigest(prefix, lines[2]!));
  });

  it('changes when a row line changes', async () => {
    expect(await chainLines(['a:message:{}', 'b:message:{"sessionID":"ses_b"}'])).not.toBe(
      await chainLines(['a:message:{}', 'b:message:{}'])
    );
  });
});
