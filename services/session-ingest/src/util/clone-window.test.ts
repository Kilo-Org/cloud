import { describe, expect, it } from 'vitest';

import type { CloneBatchRow } from '../dos/SessionIngestDO';
import { chainCloneRowDigests, cloneSourceDigestLine, cloneSourceRowBytes } from './clone-window';

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

describe('chainCloneRowDigests', () => {
  it('hashes a single row line as the chain seed', async () => {
    const single = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('message/msg_01:message:{}')
    );
    expect(await chainCloneRowDigests(['message/msg_01:message:{}'])).toBe(
      Array.from(new Uint8Array(single), byte => byte.toString(16).padStart(2, '0')).join('')
    );
  });

  it('is independent of how the rows are grouped', async () => {
    const lines = ['a:message:{}', 'b:message:{}', 'c:message:{}'];
    const prefix = await chainCloneRowDigests(lines.slice(0, 2));
    // Resuming the chain from a saved prefix produces the same final value as
    // one pass over every line.
    const rest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${prefix}\n${lines[2]}`)
    );
    expect(await chainCloneRowDigests(lines)).toBe(
      Array.from(new Uint8Array(rest), byte => byte.toString(16).padStart(2, '0')).join('')
    );
  });

  it('changes when a row line changes', async () => {
    const lines = ['a:message:{}', 'b:message:{}'];
    const changed = ['a:message:{}', 'b:message:{"sessionID":"ses_b"}'];
    expect(await chainCloneRowDigests(changed)).not.toBe(await chainCloneRowDigests(lines));
  });
});
