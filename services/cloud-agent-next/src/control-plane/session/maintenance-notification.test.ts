import { describe, expect, it, vi } from 'vitest';
import { notifyMaintenanceCompletion } from './maintenance-notification.js';
import { retainMaintenanceOutcome } from './maintenance-state.js';
import type { MaintenanceOutcome } from '../../shared/pr-maintenance.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { NotificationsBinding } from '../../notifications-binding.js';

const attemptId = '11111111-1111-4111-8111-111111111111';
const publication = {
  status: 'published' as const,
  source: 'git' as const,
  repoUrl: 'https://github.com/example/repository',
  headRef: 'feature',
  observedHeadSha: 'a'.repeat(40),
  pushedHeadSha: 'b'.repeat(40),
  remoteHeadSha: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
  exactLease: `refs/heads/feature:${'a'.repeat(40)}`,
  pushExitCode: 0 as const,
  verifiedAt: '2026-11-12T12:00:00.000Z',
};
const metadata: SessionMetadata = {
  metadataSchemaVersion: 2,
  identity: { sessionId: 'workspace_fixture', userId: 'synthetic-owner' },
  auth: { kiloSessionId: 'ses_fixture' },
  lifecycle: { version: 1, timestamp: 1 },
  chat: {
    kind: 'maintenance',
    watchId: '22222222-2222-4222-8222-222222222222',
    attemptId,
    publication: {
      repoUrl: publication.repoUrl,
      headRef: 'feature',
      baseRef: 'main',
      observedHeadSha: publication.observedHeadSha,
      baseSha: publication.baseSha,
    },
  },
};
async function fixture(patch: Partial<NonNullable<MaintenanceOutcome['result']>> = {}) {
  const values = new Map<string, unknown>();
  const storage = {
    async get(key: string) {
      return values.get(key);
    },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      if (typeof key === 'string') values.set(key, value);
      else for (const [name, entry] of Object.entries(key)) values.set(name, entry);
    },
  } as unknown as DurableObjectStorage;
  const messages = [{ messageId: 'message_one' }];
  await retainMaintenanceOutcome(
    storage,
    metadata,
    'message_one',
    {
      attemptId,
      messageId: 'message_one',
      publication,
      result: {
        version: 1,
        summary: 'Repair complete.',
        changedFiles: ['repair.txt'],
        verification: [
          { command: 'test', outcome: 'passed', summary: 'Passed.', evidenceUrls: [] },
        ],
        publication,
        problems: [],
        needsInput: null,
        ...patch,
      },
      workspace: {
        status: 'observed',
        source: 'git',
        headSha: publication.pushedHeadSha,
        remoteHeadSha: publication.remoteHeadSha,
        dirty: false,
        verifiedAt: '2026-11-12T12:01:00.000Z',
      },
    },
    messages
  );
  const send = vi.fn().mockResolvedValue({ dispatched: true });
  const notifications = {
    sendCloudAgentSessionNotification: send,
  } as unknown as NotificationsBinding;
  return { storage, messages, metadata, notifications, send };
}

describe('meaningful maintenance completion notification', () => {
  it('uses the existing preference-aware mechanism once per attempt across replay', async () => {
    const input = await fixture();
    await notifyMaintenanceCompletion(input);
    await notifyMaintenanceCompletion(input);
    expect(input.send).toHaveBeenCalledOnce();
    expect(input.send).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: `maintenance:${attemptId}`,
        status: 'completed',
        category: 'status',
        suppressIfViewingSession: true,
      })
    );
    expect(input.send.mock.calls[0]?.[0].body).not.toContain('checks passed');
  });
  it.each([
    { needsInput: 'Choose.' },
    { verification: [] },
    {
      verification: [
        { command: 'test', outcome: 'failed' as const, summary: 'Failed.', evidenceUrls: [] },
      ],
    },
  ])('does not notify routine waits or unverified completion', async patch => {
    const input = await fixture(patch);
    await notifyMaintenanceCompletion(input);
    expect(input.send).not.toHaveBeenCalled();
  });
  it('retries a transient notification transport failure within a bound', async () => {
    const input = await fixture();
    input.send.mockRejectedValueOnce(new Error('synthetic transport failure'));
    await notifyMaintenanceCompletion(input);
    expect(input.send).toHaveBeenCalledTimes(2);
  });
  it('does not notify a late completion after Stop', async () => {
    const input = await fixture();
    await input.storage.put('pr-maintenance/stopped-at', 1000);
    await notifyMaintenanceCompletion(input);
    expect(input.send).not.toHaveBeenCalled();
  });
});
