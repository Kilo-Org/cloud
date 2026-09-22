import { describe, expect, it } from 'vitest';
import {
  autoCommitRecordSchema,
  commitHashSchema,
  MAX_AUTO_COMMIT_MESSAGE_BYTES,
} from './cloud-agent-commits.js';

const record = {
  commitHash: 'a'.repeat(40),
  commitMessage: 'actual message',
  userMessageId: 'user',
  messageId: 'assistant',
  committedAt: '2026-09-01T10:00:00Z',
  pushStatus: 'failed',
};

describe('auto-commit metadata contracts', () => {
  it('accepts full SHA-1 and SHA-256 only', () => {
    for (const hash of ['a'.repeat(40), 'b'.repeat(64)])
      expect(commitHashSchema.safeParse(hash).success).toBe(true);
    for (const hash of ['abcd123', 'HEAD', '-x', 'a'.repeat(41), 'A'.repeat(40)])
      expect(commitHashSchema.safeParse(hash).success).toBe(false);
  });

  it('keeps status data outside the bounded commit record', () => {
    expect(
      autoCommitRecordSchema.parse({ ...record, success: false, message: 'Push failed' })
    ).toEqual(record);
    expect(autoCommitRecordSchema.safeParse({ ...record, committedAt: 'yesterday' }).success).toBe(
      false
    );
  });

  it('limits messages by UTF-8 bytes', () => {
    expect(
      autoCommitRecordSchema.safeParse({
        ...record,
        commitMessage: 'é'.repeat(MAX_AUTO_COMMIT_MESSAGE_BYTES / 2),
      }).success
    ).toBe(true);
    expect(
      autoCommitRecordSchema.safeParse({
        ...record,
        commitMessage: 'é'.repeat(MAX_AUTO_COMMIT_MESSAGE_BYTES / 2) + 'a',
      }).success
    ).toBe(false);
  });

  it.each(['userMessageId', 'messageId'] as const)('bounds %s to 256 characters', field => {
    expect(autoCommitRecordSchema.safeParse({ ...record, [field]: 'a'.repeat(256) }).success).toBe(
      true
    );
    for (const value of ['', 'a'.repeat(257)])
      expect(autoCommitRecordSchema.safeParse({ ...record, [field]: value }).success).toBe(false);
  });

  it('accepts only true or absent truncation metadata', () => {
    expect(autoCommitRecordSchema.parse(record)).not.toHaveProperty('commitMessageTruncated');
    expect(
      autoCommitRecordSchema.parse({ ...record, commitMessageTruncated: true })
    ).toHaveProperty('commitMessageTruncated', true);
    for (const commitMessageTruncated of [false, null, 'true'])
      expect(autoCommitRecordSchema.safeParse({ ...record, commitMessageTruncated }).success).toBe(
        false
      );
  });
});
