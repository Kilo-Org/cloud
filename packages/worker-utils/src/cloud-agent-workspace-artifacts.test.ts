import { describe, expect, it } from 'vitest';
import {
  deleteWorkspaceArtifactOutputSchema,
  getWorkspaceArtifactDownloadUrlOutputSchema,
  listWorkspaceArtifactsOutputSchema,
  workspaceArtifactEntrySchema,
} from './cloud-agent-workspace-artifacts';

const entry = {
  relativePath: 'reports/weekly.pdf',
  contentHash: 'a'.repeat(64),
  sizeBytes: 1_024,
  contentType: 'application/pdf',
  updatedAt: 1_760_000_000_000,
};

describe('workspace artifact schemas', () => {
  it('accepts a list response with entries', () => {
    expect(listWorkspaceArtifactsOutputSchema.parse({ revision: 3, entries: [entry] })).toEqual({
      revision: 3,
      entries: [entry],
    });
  });

  it('allows an empty list at revision zero', () => {
    expect(listWorkspaceArtifactsOutputSchema.parse({ revision: 0, entries: [] })).toEqual({
      revision: 0,
      entries: [],
    });
  });

  it('drops the per-file expiry sent by older Workers', () => {
    expect(
      listWorkspaceArtifactsOutputSchema.parse({
        revision: 3,
        entries: [{ ...entry, expiresAt: entry.updatedAt + 1_000 }],
      })
    ).toEqual({ revision: 3, entries: [entry] });
  });

  it('rejects a malformed content hash', () => {
    expect(
      workspaceArtifactEntrySchema.safeParse({ ...entry, contentHash: 'not-a-hash' }).success
    ).toBe(false);
  });

  it('rejects unexpected fields', () => {
    expect(
      listWorkspaceArtifactsOutputSchema.safeParse({
        revision: 1,
        entries: [{ ...entry, objectKey: 'sandbox/object' }],
      }).success
    ).toBe(false);
  });

  it('accepts download URLs and expiry', () => {
    expect(
      getWorkspaceArtifactDownloadUrlOutputSchema.parse({
        url: 'https://example.com/download',
        expiresAt: 1_760_000_300_000,
      })
    ).toEqual({ url: 'https://example.com/download', expiresAt: 1_760_000_300_000 });
  });

  it('rejects download URLs the browser must not navigate to', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://example.com/download',
    ]) {
      expect(
        getWorkspaceArtifactDownloadUrlOutputSchema.safeParse({ url, expiresAt: 1 }).success
      ).toBe(false);
    }
    expect(
      getWorkspaceArtifactDownloadUrlOutputSchema.safeParse({
        url: 'http://127.0.0.1:8899/bucket/key',
        expiresAt: 1,
      }).success
    ).toBe(true);
  });

  it('accepts every delete status', () => {
    for (const status of ['deleted', 'absent', 'hash_mismatch'] as const) {
      expect(deleteWorkspaceArtifactOutputSchema.parse({ status, revision: 4 })).toEqual({
        status,
        revision: 4,
      });
    }
  });
});
