import { describe, expect, it } from 'vitest';
import {
  retainMaintenanceOutcome,
  readMaintenanceAttemptResult,
  readMaintenanceOutcome,
} from './maintenance-state.js';
import type { MaintenanceOutcome } from '../../shared/pr-maintenance.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';

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
const workspace = {
  status: 'observed' as const,
  source: 'git' as const,
  headSha: publication.pushedHeadSha,
  remoteHeadSha: publication.remoteHeadSha,
  dirty: false,
  verifiedAt: '2026-11-12T12:01:00.000Z',
};
const metadata: SessionMetadata = {
  metadataSchemaVersion: 2,
  identity: { sessionId: 'workspace_fixture', userId: 'synthetic-owner' },
  auth: {},
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
const result = {
  version: 1 as const,
  summary: 'Repair verified.',
  changedFiles: ['repair.txt'],
  verification: [],
  publication,
  problems: [],
  needsInput: null,
};
function fixture() {
  const values = new Map<string, unknown>();
  const storage = {
    async get(key: string) {
      return values.get(key);
    },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      if (typeof key === 'string') values.set(key, value);
      else for (const [name, entry] of Object.entries(key)) values.set(name, entry);
    },
    async delete(keys: string[]) {
      for (const key of keys) values.delete(key);
    },
  } as unknown as DurableObjectStorage;
  return { storage, values };
}
const outcome = (
  messageId: string,
  fields: Partial<MaintenanceOutcome> = {}
): MaintenanceOutcome => ({
  attemptId,
  messageId,
  publication: { status: 'not_attempted', reason: 'No new publication.' },
  result: null,
  workspace,
  ...fields,
});

describe('bounded maintenance attempt results', () => {
  it('retains published work and the latest valid result across an answer and ordinary discussion', async () => {
    const { storage } = fixture();
    const messages = ['message_one', 'message_answer', 'message_discussion'].map(messageId => ({
      messageId,
    }));
    await retainMaintenanceOutcome(
      storage,
      metadata,
      'message_one',
      outcome('message_one', {
        publication,
        result: { ...result, needsInput: 'Choose the follow-up.' },
      }),
      messages
    );
    await retainMaintenanceOutcome(
      storage,
      metadata,
      'message_answer',
      outcome('message_answer', { result }),
      messages
    );
    await retainMaintenanceOutcome(
      storage,
      metadata,
      'message_discussion',
      outcome('message_discussion'),
      messages
    );
    expect(await readMaintenanceAttemptResult(storage, messages)).toMatchObject({
      result,
      publication,
      resultMessageId: 'message_answer',
      publicationMessageId: 'message_one',
    });
    expect(await readMaintenanceOutcome(storage, 'message_one')).toMatchObject({ publication });
  });

  it('preserves questions without inventing that an unstructured answer resolved them', async () => {
    const { storage } = fixture();
    const messages = [{ messageId: 'first' }, { messageId: 'answer' }];
    await retainMaintenanceOutcome(
      storage,
      metadata,
      'first',
      outcome('first', { publication, result: { ...result, needsInput: 'Choose.' } }),
      messages
    );
    await retainMaintenanceOutcome(storage, metadata, 'answer', outcome('answer'), messages);
    expect(await readMaintenanceAttemptResult(storage, messages)).toMatchObject({
      publication,
      result: { needsInput: 'Choose.' },
      resultMessageId: 'first',
    });
  });

  it.each([
    { ...workspace, dirty: true },
    { ...workspace, headSha: 'd'.repeat(40) },
    { status: 'unavailable' as const, reason: 'maintenance_remote_head_unavailable' },
  ])('does not promote stale publication over new or unverified work', async current => {
    const { storage } = fixture();
    const messages = [{ messageId: 'first' }, { messageId: 'followup' }];
    await retainMaintenanceOutcome(
      storage,
      metadata,
      'first',
      outcome('first', { publication, result }),
      messages
    );
    await retainMaintenanceOutcome(
      storage,
      metadata,
      'followup',
      outcome('followup', { workspace: current }),
      messages
    );
    const state = await readMaintenanceAttemptResult(storage, messages);
    expect(state.publication?.status).toBe('unknown');
    expect(state.result?.summary).toBe(result.summary);
    expect(state.lastPublished).toEqual({ messageId: 'first', publication });
  });

  it('retains exact publication even when no structured result was valid', async () => {
    const { storage } = fixture();
    const messages = [{ messageId: 'first' }];
    await retainMaintenanceOutcome(
      storage,
      metadata,
      'first',
      outcome('first', { publication }),
      messages
    );
    expect(await readMaintenanceAttemptResult(storage, messages)).toMatchObject({
      result: null,
      publication,
      publicationMessageId: 'first',
    });
  });

  it('does not let a no-change result hide later unpublished work without an earlier push', async () => {
    const { storage } = fixture();
    const messages = [{ messageId: 'first' }, { messageId: 'followup' }];
    const noPublication = { status: 'not_attempted' as const, reason: 'No change was needed.' };
    await retainMaintenanceOutcome(
      storage,
      metadata,
      'first',
      outcome('first', {
        result: { ...result, changedFiles: [], publication: noPublication },
        publication: noPublication,
      }),
      messages
    );
    await retainMaintenanceOutcome(
      storage,
      metadata,
      'followup',
      outcome('followup', { workspace: { ...workspace, dirty: true } }),
      messages
    );
    expect(await readMaintenanceAttemptResult(storage, messages)).toMatchObject({
      result: { summary: result.summary },
      publication: { status: 'unknown' },
    });
  });

  it('keeps result provenance when the wrapper finishes a later message in the same turn', async () => {
    const { storage } = fixture();
    const messages = [{ messageId: 'first' }, { messageId: 'later' }];
    await retainMaintenanceOutcome(
      storage,
      metadata,
      'first',
      outcome('first', { publication }),
      messages
    );
    await retainMaintenanceOutcome(
      storage,
      metadata,
      'later',
      outcome('later', { result, resultMessageId: 'first' }),
      messages
    );
    expect(await readMaintenanceAttemptResult(storage, messages)).toMatchObject({
      resultMessageId: 'first',
      publicationMessageId: 'first',
      result,
    });
  });

  it('bounds per-message records and retains only current result/publication anchors', async () => {
    const { storage, values } = fixture();
    const messages = Array.from({ length: 80 }, (_, index) => ({ messageId: `message_${index}` }));
    for (const [index, message] of messages.entries()) {
      await retainMaintenanceOutcome(
        storage,
        metadata,
        message.messageId,
        outcome(message.messageId, index === 0 ? { publication, result } : {}),
        messages
      );
    }
    expect(
      [...values.keys()].filter(key => key.startsWith('pr-maintenance/outcome/')).length
    ).toBeLessThanOrEqual(34);
    expect(await readMaintenanceAttemptResult(storage, messages)).toMatchObject({
      resultMessageId: 'message_0',
      publicationMessageId: 'message_0',
    });
  });
});
