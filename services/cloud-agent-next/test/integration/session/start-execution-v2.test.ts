/**
 * Integration tests for DO-orchestrated V2 execution start.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, it, expect, vi } from 'vitest';
import {
  createPendingSessionMessage,
  listPendingSessionMessages,
  storePendingSessionMessage,
} from '../../../src/session/pending-messages.js';
import { createEventQueries } from '../../../src/session/queries/events.js';
import { listNonTerminalAcceptedMessages } from '../../../src/session/session-message-state.js';
import { branchNameSchema } from '../../../src/persistence/schemas.js';

import {
  groupedRegisterSessionInput,
  queueRegisteredInitialInput,
  queueUserMessageInput,
  registerReadySession,
} from '../../helpers/session-setup.js';

describe('CloudAgentSession message admission', () => {
  it('persists a readable default branch before preparation and retains it on registration retry', async () => {
    const userId = 'user_readable_branch';
    const sessionId = 'agent_readable_branch';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );
    const input = groupedRegisterSessionInput({
      sessionId,
      userId,
      prompt: 'use a readable branch',
      mode: 'code',
      model: 'test-model',
      githubRepo: 'acme/repo',
    });

    const first = await stub.registerSession(input);
    const metadata = await stub.getMetadata();
    const replay = await stub.registerSession(input);
    const replayedMetadata = await stub.getMetadata();

    expect(first).toEqual({ success: true });
    expect(metadata?.workspace?.branchName).toMatch(/^kilo\/[a-z]+-[a-z]+-[a-z2-7]{8}$/);
    expect(branchNameSchema.safeParse(metadata?.workspace?.branchName).success).toBe(true);
    expect(metadata?.repository?.upstreamBranch).toBeUndefined();
    expect(metadata?.lifecycle.preparedAt).toBeUndefined();
    expect(replay).toEqual({ success: false, error: 'Session already registered' });
    expect(replayedMetadata?.workspace?.branchName).toBe(metadata?.workspace?.branchName);
  });

  it.each(['main', 'feature/custom-branch', 'refs/pull/4273/head'])(
    'preserves the explicit branch %s during registration',
    async branch => {
      const userId = 'user_explicit_branch';
      const sessionId = `agent_explicit_branch_${branch.replaceAll('/', '_')}`;
      const stub = env.CLOUD_AGENT_SESSION.get(
        env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
      );

      const result = await stub.registerSession(
        groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'keep the selected branch',
          mode: 'code',
          model: 'test-model',
          githubRepo: 'acme/repo',
          upstreamBranch: branch,
        })
      );
      const metadata = await stub.getMetadata();

      expect(result).toEqual({ success: true });
      expect(metadata?.repository?.upstreamBranch).toBe(branch);
      expect(metadata?.workspace?.branchName).toBe(branch);
    }
  );

  it('admits the already accepted initial turn through grouped session creation', async () => {
    const userId = 'user_grouped_start' as const;
    const sessionId = 'agent_grouped_start' as const;
    const messageId = 'msg_018f1e2d3c4bInitMsgAbCdEfG';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      const admitted = await instance.createSessionWithInitialAdmission({
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'admit my first turn',
          mode: 'code',
          model: 'test-model',
          kiloSessionId: '11111111-1111-4111-9111-111111111111',
          kilocodeToken: 'token-grouped-start',
        }),
        message: {
          initialTurn: {
            type: 'prompt',
            messageId,
            prompt: 'admit my first turn',
          },
        },
      });
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const metadata = await instance.getMetadata();
      return { admitted, pending, metadata };
    });

    expect(result.admitted).toMatchObject({
      success: true,
      messageId,
      outcome: 'queued',
      compatibilityDelivery: 'queued',
    });
    expect(result.metadata?.initialMessage?.id).toBe(messageId);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe(messageId);
    expect(result.pending[0]?.content).toBe('admit my first turn');
  });

  it('persists and admits canonical document attachments during grouped session creation', async () => {
    const userId = 'user_grouped_document_start' as const;
    const sessionId = 'agent_grouped_document_start' as const;
    const messageId = 'msg_018f1e2d3c4bDocInitAbCdEfG';
    const attachments = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
    };
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const admitted = await instance.createSessionWithInitialAdmission({
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'summarize document',
          mode: 'code',
          model: 'test-model',
          kiloSessionId: '21212121-2121-4121-9121-212121212121',
          kilocodeToken: 'token-grouped-document-start',
        }),
        message: {
          initialTurn: { type: 'prompt', messageId, prompt: 'summarize document', attachments },
        },
      });
      return {
        admitted,
        metadata: await instance.getMetadata(),
        pending: await listPendingSessionMessages(instance.ctx.storage),
      };
    });

    expect(result.admitted).toMatchObject({ success: true, messageId });
    expect(result.metadata?.initialMessage?.attachments).toEqual(attachments);
    expect(result.pending[0]?.intent?.turn).toMatchObject({ attachments });
  });

  it('rejects registration metadata with an untyped repository', async () => {
    const userId = 'user_untyped_repository' as const;
    const sessionId = 'agent_untyped_repository' as const;
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const registration = await instance.registerSession({
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'review PR 4273',
          mode: 'code',
          model: 'test-model',
          kiloSessionId: '31313131-3131-4131-9131-313131313131',
          kilocodeToken: 'token-untyped-repository',
        }),
        repository: {
          repo: 'Kilo-Org/cloud',
          branch: 'refs/pull/4273/head',
        } as any,
      });
      const metadata = await instance.getMetadata();

      return { registration, metadata };
    });

    expect(result.registration).toEqual({
      success: false,
      error: 'Invalid metadata: repository.type must be github, gitlab, bitbucket, or git',
    });
    expect(result.metadata).toBeNull();
  });

  it('persists Vercel provider selection without obsolete ownership control state', async () => {
    const userId = 'user_vercel_selection' as const;
    const sessionId = 'agent_vercel_selection' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      const registration = await instance.registerSession({
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'select Vercel privately',
          mode: 'code',
          model: 'test-model',
        }),
        workspace: {
          sandboxId: 'ses-abcdef',
          sandboxProvider: 'vercel',
        },
      });
      return {
        registration,
        metadata: await instance.getMetadata(),
      };
    });

    expect(result.registration.success).toBe(true);
    expect(result.metadata?.workspace?.sandboxProvider).toBe('vercel');
    expect(result.metadata?.workspace?.sandboxId).toBe('ses-abcdef');
    expect(result.metadata?.workspace?.providerRuntime).toBeUndefined();
  });

  it('finalizes inert Vercel deletion because disabled runtime integration could not create a resource', async () => {
    const userId = 'user_vercel_inert_delete' as const;
    const sessionId = 'agent_vercel_inert_delete' as const;
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession({
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'delete without runtime',
          mode: 'code',
          model: 'test-model',
        }),
        workspace: { sandboxId: 'ses-acde1234', sandboxProvider: 'vercel' },
      });
      await instance.deleteSession();
      return {
        metadata: await instance.getMetadata(),
        remainingKeys: [...(await instance.ctx.storage.list()).keys()],
      };
    });

    expect(result.metadata).toBeNull();
    expect(result.remainingKeys).toEqual([]);
  });

  it('purges large Vercel payloads in bounded batches before exact-session stop', async () => {
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName('user_vercel_purge:agent_vercel_purge')
    );

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession({
        ...groupedRegisterSessionInput({
          sessionId: 'agent_vercel_purge',
          userId: 'user_vercel_purge',
          prompt: 'private prompt',
          mode: 'code',
          model: 'test-model',
        }),
        workspace: { sandboxId: 'ses-acde1234', sandboxProvider: 'vercel' },
      });
      const metadata = await instance.getMetadata();
      if (!metadata) throw new Error('Expected registered metadata');
      await instance.ctx.storage.put('metadata', {
        ...metadata,
        workspace: {
          ...metadata.workspace,
          providerRuntime: { provider: 'vercel', sessionId: 'session-exact-1' },
        },
      });
      for (let start = 0; start < 260; start += 100) {
        await instance.ctx.storage.put(
          Object.fromEntries(
            Array.from({ length: Math.min(100, 260 - start) }, (_, index) => [
              `private:${String(start + index).padStart(3, '0')}`,
              `user material ${start + index}`,
            ])
          )
        );
      }
      const eventQueries = createEventQueries(
        drizzle(instance.ctx.storage, { logger: false }),
        instance.ctx.storage.sql
      );
      eventQueries.insert({
        executionId: 'execution-private',
        sessionId: 'agent_vercel_purge',
        streamEventType: 'kilocode',
        payload: '{"private":"event"}',
        timestamp: Date.now(),
      });

      Object.assign(instance.env, {
        VERCEL_TOKEN: 'test-token',
        VERCEL_TEAM_ID: 'test-team',
        VERCEL_PROJECT_ID: 'test-project',
        VERCEL_SANDBOX_SNAPSHOT_ID: 'test-snapshot',
        VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'test-build',
        VERCEL_SANDBOX_RUNTIME: 'node24',
        VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
        VERCEL_SANDBOX_EXTEND_DURATION_MS: '600000',
      });

      const listLimits: Array<number | undefined> = [];
      const deleteBatchSizes: number[] = [];
      const tombstoneSurvived: boolean[] = [];
      const originalList = instance.ctx.storage.list.bind(instance.ctx.storage);
      const originalDelete = instance.ctx.storage.delete.bind(instance.ctx.storage);
      vi.spyOn(instance.ctx.storage, 'list').mockImplementation(async options => {
        listLimits.push(options?.limit);
        return originalList(options);
      });
      vi.spyOn(instance.ctx.storage, 'delete').mockImplementation(async keys => {
        if (Array.isArray(keys)) deleteBatchSizes.push(keys.length);
        const deleted = await originalDelete(keys as string & string[]);
        if (Array.isArray(keys)) {
          tombstoneSurvived.push(
            (await instance.ctx.storage.get('vercel_deletion_tombstone')) !== undefined
          );
        }
        return deleted;
      });

      let keysDuringStop: string[] = [];
      let eventsDuringStop = -1;
      const stopSession = vi.fn(async () => {
        keysDuringStop = [...(await originalList()).keys()];
        eventsDuringStop = eventQueries.findByFilters({}).length;
        throw new Error('lost stop response');
      });
      vi.spyOn((instance as any).getSandboxLifecycle(), 'restClient').mockReturnValue({
        stopSession,
        getSession: vi.fn().mockResolvedValue({ session: { status: 'running' }, routes: [] }),
      });
      const putSpy = vi.spyOn(instance.ctx.storage, 'put');

      await instance.deleteSession();
      await (instance as any).purgeDeletedSessionPayload();
      const atomicFenceCommitted = putSpy.mock.calls.some(([entries]) => {
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return false;
        return 'session_deletion_intent' in entries && 'vercel_deletion_tombstone' in entries;
      });
      return {
        listLimits,
        deleteBatchSizes,
        tombstoneSurvived,
        keysDuringStop,
        eventsDuringStop,
        remainingKeys: [...(await originalList()).keys()],
        remainingEvents: eventQueries.findByFilters({}).length,
        stopCalls: stopSession.mock.calls,
        atomicFenceCommitted,
      };
    });

    expect(result.atomicFenceCommitted).toBe(true);
    expect(result.listLimits.every(limit => limit === 128)).toBe(true);
    expect(result.deleteBatchSizes.length).toBeGreaterThan(2);
    expect(result.deleteBatchSizes.every(size => size <= 128)).toBe(true);
    expect(result.tombstoneSurvived.every(Boolean)).toBe(true);
    expect(result.keysDuringStop).toEqual(['session_deletion_intent', 'vercel_deletion_tombstone']);
    expect(result.eventsDuringStop).toBe(0);
    expect(result.remainingKeys).toEqual(['session_deletion_intent', 'vercel_deletion_tombstone']);
    expect(result.remainingEvents).toBe(0);
    expect(result.stopCalls[0]?.slice(0, 2)).toEqual(['session-exact-1', 'ses-acde1234']);
  });

  it('settles a lost exact-session stop response through terminal inspection', async () => {
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName('user_vercel_stop_loss:agent_vercel_stop_loss')
    );

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession({
        ...groupedRegisterSessionInput({
          sessionId: 'agent_vercel_stop_loss',
          userId: 'user_vercel_stop_loss',
          prompt: 'stop exactly once',
          mode: 'code',
          model: 'test-model',
        }),
        workspace: { sandboxId: 'ses-acde5678', sandboxProvider: 'vercel' },
      });
      const metadata = await instance.getMetadata();
      if (!metadata) throw new Error('Expected registered metadata');
      await instance.ctx.storage.put('metadata', {
        ...metadata,
        workspace: {
          ...metadata.workspace,
          providerRuntime: { provider: 'vercel', sessionId: 'session-stop-loss' },
        },
      });
      Object.assign(instance.env, { VERCEL_TOKEN: 'test-token', VERCEL_TEAM_ID: 'test-team' });
      const stopSession = vi.fn().mockRejectedValue(new Error('response lost'));
      const getSession = vi.fn().mockResolvedValue({
        session: { status: 'stopped' },
        routes: [],
      });
      vi.spyOn((instance as any).getSandboxLifecycle(), 'restClient').mockReturnValue({
        stopSession,
        getSession,
      });

      await instance.deleteSession();
      return {
        remainingKeys: [...(await instance.ctx.storage.list()).keys()],
        stopCalls: stopSession.mock.calls,
        inspectCalls: getSession.mock.calls,
      };
    });

    expect(result.remainingKeys).toEqual([]);
    expect(result.stopCalls[0]).toEqual(['session-stop-loss', 'ses-acde5678']);
    expect(result.inspectCalls[0]).toEqual(['session-stop-loss', 'ses-acde5678']);
  });

  it('adopts a matching late create and stops only its exact session', async () => {
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName('user_vercel_late_create:agent_vercel_late_create')
    );

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession({
        ...groupedRegisterSessionInput({
          sessionId: 'agent_vercel_late_create',
          userId: 'user_vercel_late_create',
          prompt: 'delete during creation',
          mode: 'code',
          model: 'test-model',
        }),
        workspace: { sandboxId: 'ses-acde9012', sandboxProvider: 'vercel' },
      });
      await instance.ctx.storage.put('vercel_create_intent', {
        version: 1,
        sandboxName: 'ses-acde9012',
        operationId: 'operation-late',
        projectId: 'project-pinned',
        snapshotId: 'snapshot-pinned',
        runtimeBuildId: 'build-pinned',
        runtime: 'node24',
        startedAt: Date.now(),
        settleUntil: Date.now() + 60_000,
        attempts: 1,
        nextRetryAt: Date.now(),
      });
      Object.assign(instance.env, { VERCEL_TOKEN: 'test-token', VERCEL_TEAM_ID: 'test-team' });
      const inspectByName = vi.fn().mockResolvedValue({ session: { id: 'session-late' } });
      const stopSession = vi.fn().mockResolvedValue({ status: 'stopped' });
      vi.spyOn((instance as any).getSandboxLifecycle(), 'restClient').mockReturnValue({
        inspectByName,
        stopSession,
      });

      await instance.deleteSession();
      return {
        remainingKeys: [...(await instance.ctx.storage.list()).keys()],
        inspectCalls: inspectByName.mock.calls,
        stopCalls: stopSession.mock.calls,
      };
    });

    expect(result.remainingKeys).toEqual([]);
    expect(result.inspectCalls[0]?.[0]).toMatchObject({
      name: 'ses-acde9012',
      operationId: 'operation-late',
      snapshotId: 'snapshot-pinned',
      runtimeBuildId: 'build-pinned',
    });
    expect(result.inspectCalls[0]?.[0]).not.toHaveProperty('timeoutMs');
    expect(result.stopCalls[0]).toEqual(['session-late', 'ses-acde9012']);
  });

  it('routes explicit and retention Cloudflare deletion through the DO sandbox lifecycle owner', async () => {
    const explicitStub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName('user_cf_explicit_delete:agent_cf_explicit_delete')
    );
    const retentionStub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName('user_cf_retention_delete:agent_cf_retention_delete')
    );

    const reasons = await runInDurableObject(explicitStub, async instance => {
      await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId: 'agent_cf_explicit_delete',
          userId: 'user_cf_explicit_delete',
          prompt: 'delete explicit',
          mode: 'code',
          model: 'test-model',
        })
      );
      const captured: string[] = [];
      vi.spyOn(instance as any, 'deleteSandboxSessionResources').mockImplementation(
        async (_metadata: unknown, reason: unknown) => {
          captured.push(String(reason));
        }
      );
      await instance.deleteSession();
      return captured;
    });

    const retained = await runInDurableObject(retentionStub, async instance => {
      await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId: 'agent_cf_retention_delete',
          userId: 'user_cf_retention_delete',
          prompt: 'delete retention',
          mode: 'code',
          model: 'test-model',
        })
      );
      const captured: string[] = [];
      vi.spyOn(instance as any, 'deleteSandboxSessionResources').mockImplementation(
        async (_metadata: unknown, reason: unknown) => {
          captured.push(String(reason));
        }
      );
      await instance.ctx.storage.put('last_activity', Date.now() - 91 * 24 * 60 * 60 * 1000);
      await instance.alarm();
      return { captured, metadata: await instance.getMetadata() };
    });

    expect(reasons).toEqual(['explicit']);
    expect(retained.captured).toEqual(['retention-expired']);
    expect(retained.metadata).toBeNull();
  });

  it('reconciles committed Cloudflare deletion intent and retains it until cleanup succeeds', async () => {
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName('user_cf_intent_recovery:agent_cf_intent_recovery')
    );

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession({
        ...groupedRegisterSessionInput({
          sessionId: 'agent_cf_intent_recovery',
          userId: 'user_cf_intent_recovery',
          prompt: 'recover interrupted deletion',
          mode: 'code',
          model: 'test-model',
        }),
        workspace: { sandboxId: 'usr-acde1234', sandboxProvider: 'cloudflare' },
      });
      await instance.ctx.storage.put('session_deletion_intent', {
        reason: 'explicit',
        startedAt: 12_000,
      });
      const cleanup = vi
        .spyOn(instance as any, 'deleteSandboxSessionResources')
        .mockRejectedValueOnce(new Error('temporary Cloudflare cleanup failure'))
        .mockResolvedValueOnce(undefined);

      await instance.alarm();
      const retained = {
        metadata: await instance.ctx.storage.get('metadata'),
        deletionIntent: await instance.ctx.storage.get('session_deletion_intent'),
        alarm: await instance.ctx.storage.getAlarm(),
      };
      await instance.alarm();
      return {
        retained,
        cleanupReasons: cleanup.mock.calls.map(call => call[1]),
        keys: [...(await instance.ctx.storage.list()).keys()],
      };
    });

    expect(result.retained.metadata).toBeDefined();
    expect(result.retained.deletionIntent).toMatchObject({ reason: 'explicit', startedAt: 12_000 });
    expect(result.retained.alarm).toEqual(expect.any(Number));
    expect(result.cleanupReasons).toEqual(['explicit', 'explicit']);
    expect(result.keys).toEqual([]);
  });

  it('keeps Cloudflare registration free of Vercel runtime state', async () => {
    const userId = 'user_cloudflare_selection' as const;
    const sessionId = 'agent_cloudflare_selection' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const workspace = await runInDurableObject(stub, async instance => {
      await instance.registerSession({
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'stay on Cloudflare',
          mode: 'code',
          model: 'test-model',
        }),
        workspace: {
          sandboxId: 'usr-abcdef',
          sandboxProvider: 'cloudflare',
        },
      });
      return (await instance.getMetadata())?.workspace;
    });

    expect(workspace?.sandboxProvider).toBe('cloudflare');
    expect(workspace?.providerRuntime).toBeUndefined();
  });

  it('surfaces initial admission failure after retaining registered DO metadata', async () => {
    const userId = 'user_grouped_start_failure' as const;
    const sessionId = 'agent_grouped_start_failure' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      for (let index = 0; index < 10; index++) {
        await storePendingSessionMessage(
          instance.ctx.storage,
          createPendingSessionMessage({
            messageId: `msg_018f1e2d3c4b${String(index).padStart(14, 'A')}`,
            role: 'user',
            content: `existing pending ${index}`,
            createdAt: index,
          })
        );
      }
      const admitted = await instance.createSessionWithInitialAdmission({
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'reject this admission',
          mode: 'code',
          model: 'test-model',
          kiloSessionId: '12121212-1212-4212-9212-121212121212',
          kilocodeToken: 'token-grouped-start-failure',
        }),
        message: {
          initialTurn: {
            type: 'prompt',
            messageId: 'msg_018f1e2d3c4bOverMsgAbCdEfG',
            prompt: 'reject this admission',
          },
        },
      });
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const metadata = await instance.getMetadata();
      return { admitted, pending, metadata };
    });

    expect(result.admitted).toMatchObject({ success: false, code: 'PENDING_QUEUE_FULL' });
    expect(result.metadata?.identity.sessionId).toBe(sessionId);
    expect(result.pending).toHaveLength(10);
    expect(result.pending.some(message => message.content === 'reject this admission')).toBe(false);
  });

  it('replays a retried grouped admission with the same canonical initial message identity', async () => {
    const userId = 'user_grouped_start_retry' as const;
    const sessionId = 'agent_grouped_start_retry' as const;
    const messageId = 'msg_018f1e2d3c4bBoundMsgAbCdEf';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);
    const input = {
      ...groupedRegisterSessionInput({
        sessionId,
        userId,
        prompt: 'retry grouped admission',
        mode: 'code',
        model: 'test-model',
        kiloSessionId: '13131313-1313-4313-9313-131313131313',
        kilocodeToken: 'token-grouped-start-retry',
      }),
      message: {
        initialTurn: {
          type: 'prompt' as const,
          messageId,
          prompt: 'retry grouped admission',
        },
      },
    };

    const result = await runInDurableObject(stub, async instance => {
      const first = await instance.createSessionWithInitialAdmission(input);
      const firstBranch = (await instance.getMetadata())?.workspace?.branchName;
      const second = await instance.createSessionWithInitialAdmission(input);
      return {
        first,
        second,
        firstBranch,
        secondBranch: (await instance.getMetadata())?.workspace?.branchName,
        pending: await listPendingSessionMessages(instance.ctx.storage),
      };
    });

    expect(result.first).toMatchObject({ success: true, messageId, outcome: 'queued' });
    expect(result.second).toEqual(result.first);
    expect(result.firstBranch).toMatch(/^kilo\/[a-z]+-[a-z]+-[a-z2-7]{8}$/);
    expect(result.secondBranch).toBe(result.firstBranch);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe(messageId);
  });

  it('does not mutate persisted provider selection when a registration replay changes environment selection', async () => {
    const userId = 'user_provider_replay' as const;
    const sessionId = 'agent_provider_replay' as const;
    const messageId = 'msg_018f1e2d3c4bBoundMsgAbCdEf';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      const initialInput = {
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'preserve provider',
          mode: 'code',
          model: 'test-model',
        }),
        workspace: {
          sandboxId: 'usr-abcdef' as const,
          sandboxProvider: 'cloudflare' as const,
        },
        message: {
          initialTurn: {
            type: 'prompt' as const,
            messageId,
            prompt: 'preserve provider',
          },
        },
      };
      await instance.createSessionWithInitialAdmission(initialInput);
      await instance.createSessionWithInitialAdmission({
        ...initialInput,
        workspace: {
          sandboxId: 'ses-abcdef',
          sandboxProvider: 'vercel',
        },
      });
      return {
        metadata: await instance.getMetadata(),
      };
    });

    expect(result.metadata?.workspace?.sandboxProvider).toBe('cloudflare');
    expect(result.metadata?.workspace?.sandboxId).toBe('usr-abcdef');
    expect(result.metadata?.workspace?.providerRuntime).toBeUndefined();
  });

  it('rejects metadata updates that attempt to change a registered sandbox provider', async () => {
    const userId = 'user_provider_update' as const;
    const sessionId = 'agent_provider_update' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession({
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'immutable provider',
          mode: 'code',
          model: 'test-model',
        }),
        workspace: {
          sandboxId: 'ses-abcdef',
          sandboxProvider: 'vercel',
        },
      });
      const metadata = await instance.getMetadata();
      if (!metadata) throw new Error('Expected metadata after registration');
      let error: string | undefined;
      try {
        await instance.updateMetadata({
          ...metadata,
          workspace: {
            ...metadata.workspace,
            sandboxProvider: 'cloudflare',
          },
        });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      return { error, metadata: await instance.getMetadata() };
    });

    expect(result.error).toContain('sandbox provider cannot be changed');
    expect(result.metadata?.workspace?.sandboxProvider).toBe('vercel');
  });

  it('rejects metadata updates that replace sandbox name or persisted Vercel session ID', async () => {
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName('user_runtime_identity:agent_runtime_identity')
    );

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession({
        ...groupedRegisterSessionInput({
          sessionId: 'agent_runtime_identity',
          userId: 'user_runtime_identity',
          prompt: 'immutable runtime identity',
          mode: 'code',
          model: 'test-model',
        }),
        workspace: { sandboxId: 'ses-abcdef', sandboxProvider: 'vercel' },
      });
      const metadata = await instance.getMetadata();
      if (!metadata) throw new Error('Expected metadata after registration');
      await instance.ctx.storage.put('metadata', {
        ...metadata,
        workspace: {
          ...metadata.workspace,
          providerRuntime: { provider: 'vercel', sessionId: 'session-1' },
        },
      });
      const pinned = await instance.getMetadata();
      if (!pinned) throw new Error('Expected pinned metadata');
      const errors: string[] = [];
      for (const workspace of [
        { ...pinned.workspace, sandboxId: 'ses-fedcba' },
        {
          ...pinned.workspace,
          providerRuntime: { provider: 'vercel', sessionId: 'session-2' },
        },
      ]) {
        try {
          await instance.updateMetadata({ ...pinned, workspace });
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return { errors, metadata: await instance.getMetadata() };
    });

    expect(result.errors).toEqual([
      'Registered sandbox name cannot be changed',
      'Persisted Vercel session ID cannot be changed',
    ]);
    expect(result.metadata?.workspace?.sandboxId).toBe('ses-abcdef');
    expect(result.metadata?.workspace?.providerRuntime?.sessionId).toBe('session-1');
  });

  it('rejects a grouped replay that changes the immutable initial intent', async () => {
    const userId = 'user_grouped_start_mismatch' as const;
    const sessionId = 'agent_grouped_start_mismatch' as const;
    const messageId = 'msg_018f1e2d3c4bMismatAbCdEfGh';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      const original = {
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'original prompt',
          mode: 'code',
          model: 'test-model',
          kiloSessionId: '14141414-1414-4414-9414-141414141414',
          kilocodeToken: 'token-grouped-start-mismatch',
        }),
        message: {
          initialTurn: { type: 'prompt' as const, messageId, prompt: 'original prompt' },
        },
      };
      const first = await instance.createSessionWithInitialAdmission(original);
      const replay = await instance.createSessionWithInitialAdmission({
        ...original,
        message: {
          initialTurn: { type: 'prompt', messageId, prompt: 'different prompt' },
        },
        agent: { ...original.agent, model: 'different-model' },
      });
      return { first, replay, pending: await listPendingSessionMessages(instance.ctx.storage) };
    });

    expect(result.first).toMatchObject({ success: true, messageId, outcome: 'queued' });
    expect(result.replay).toMatchObject({ success: false, code: 'BAD_REQUEST' });
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.content).toBe('original prompt');
    expect(result.pending[0]?.intent?.agent.model).toBe('test-model');
  });

  it('persists shared route metadata and rejects a replay with another assignment', async () => {
    const userId = 'user_grouped_route_replay' as const;
    const sessionId = 'agent_grouped_route_replay' as const;
    const messageId = 'msg_018f1e2d3c4bRouteMAbCdEfGh';
    const routeKey = 'usr-000000000000000000000000000000000000000000000000' as const;
    const sandboxId = 'usr-b4593afcaf2e9e1dfb1611150b786cfe8aeba3c77352a3df' as const;
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );
    const base = groupedRegisterSessionInput({
      sessionId,
      userId,
      prompt: 'persist shared route',
      mode: 'code',
      model: 'test-model',
      kiloSessionId: '15151515-1515-4515-9515-151515151515',
      kilocodeToken: 'token-grouped-route',
    });
    const input = {
      ...base,
      workspace: {
        sandboxId,
        sandboxProvider: 'cloudflare' as const,
        sandboxRoute: {
          kind: 'shared' as const,
          routeKey,
          suffix: 'shared-slot-v1' as const,
        },
      },
      message: {
        initialTurn: {
          type: 'prompt' as const,
          messageId,
          prompt: 'persist shared route',
        },
      },
    };

    const result = await runInDurableObject(stub, async instance => {
      const first = await instance.createSessionWithInitialAdmission(input);
      const replay = await instance.createSessionWithInitialAdmission({
        ...input,
        workspace: {
          sandboxId: routeKey,
          sandboxRoute: { kind: 'shared', routeKey },
        },
      });
      return { first, replay, metadata: await instance.getMetadata() };
    });

    expect(result.first).toMatchObject({ success: true, messageId });
    expect(result.replay).toMatchObject({ success: false, code: 'BAD_REQUEST' });
    expect(result.metadata?.workspace).toMatchObject(input.workspace);
  });

  it('rejects readiness updates that change a shared route to another sandbox', async () => {
    const userId = 'user_shared_route_ready_mismatch' as const;
    const sessionId = 'agent_shared_route_ready_mismatch' as const;
    const routeKey = 'usr-000000000000000000000000000000000000000000000000' as const;
    const sandboxId = 'usr-b4593afcaf2e9e1dfb1611150b786cfe8aeba3c77352a3df' as const;
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const registration = await instance.registerSession({
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'preserve shared assignment',
          mode: 'code',
          model: 'test-model',
          kiloSessionId: '17171717-1717-4717-9717-171717171717',
          kilocodeToken: 'token-shared-route-ready',
        }),
        workspace: {
          sandboxId,
          sandboxRoute: {
            kind: 'shared',
            routeKey,
            suffix: 'shared-slot-v1',
          },
        },
      });
      const ready = await instance.recordSessionReady({
        workspacePath: `/workspace/${userId}/sessions/${sessionId}`,
        sandboxId: 'usr-111111111111111111111111111111111111111111111111',
        sessionHome: `/home/${sessionId}`,
        branchName: `session/${sessionId}`,
        kiloSessionId: '17171717-1717-4717-9717-171717171717',
      });
      return { registration, ready, metadata: await instance.getMetadata() };
    });

    expect(result.registration.success).toBe(true);
    expect(result.ready).toMatchObject({
      success: false,
      error: expect.stringContaining('does not match its route suffix'),
    });
    expect(result.metadata?.workspace?.sandboxId).toBe(sandboxId);
  });

  it('rejects shared route metadata whose sandbox does not match its suffix', async () => {
    const userId = 'user_invalid_shared_route' as const;
    const sessionId = 'agent_invalid_shared_route' as const;
    const routeKey = 'usr-000000000000000000000000000000000000000000000000' as const;
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, instance =>
      instance.registerSession({
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'reject invalid shared route',
          mode: 'code',
          model: 'test-model',
          kiloSessionId: '16161616-1616-4616-9616-161616161616',
          kilocodeToken: 'token-invalid-shared-route',
        }),
        workspace: {
          sandboxId: 'usr-111111111111111111111111111111111111111111111111',
          sandboxRoute: {
            kind: 'shared',
            routeKey,
            suffix: 'shared-slot-v1',
          },
        },
      })
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('does not match its route suffix'),
    });
  });

  it('persists repaired DIND devcontainer workspace readiness metadata', async () => {
    const userId = 'user_devcontainer_ready' as const;
    const sessionId = 'agent_devcontainer_ready' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);
    const devcontainer = {
      workspacePath: '/workspace/user/sessions/agent_devcontainer_ready',
      innerWorkspaceFolder: '/workspaces/repo',
      wrapperPort: 4173,
      configPath: '.devcontainer/devcontainer.json',
    };

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'prepare devcontainer',
          mode: 'code',
          model: 'test-model',
          kiloSessionId: '19191919-1919-4919-9919-191919191919',
          kilocodeToken: 'token-devcontainer',
        })
      );

      const ready = await instance.recordSessionReady({
        workspacePath: devcontainer.workspacePath,
        sandboxId: 'dind-abcdef',
        sessionHome: '/home/agent_devcontainer_ready',
        branchName: 'session/agent_devcontainer_ready',
        kiloSessionId: '19191919-1919-4919-9919-191919191919',
        devcontainer,
      });
      const metadata = await instance.getMetadata();
      return { ready, metadata };
    });

    expect(result.ready.success).toBe(true);
    expect(result.metadata?.workspace?.sandboxId).toBe('dind-abcdef');
    expect(result.metadata?.devcontainer).toEqual(devcontainer);
  });

  it('drains prepared devcontainer sessions with their persisted DIND workspace plan', async () => {
    const userId = 'user_devcontainer_plan' as const;
    const sessionId = 'agent_devcontainer_plan' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let capturedPlan: any = null;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          capturedPlan = plan;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };

      await instance.registerSession({
        ...groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'prepare devcontainer execution',
          mode: 'code',
          model: 'test-model',
          kiloSessionId: '20202020-2020-4020-9020-202020202020',
          kilocodeToken: 'token-devcontainer',
        }),
        workspace: {
          sandboxId: 'dind-abcdef',
          devcontainerRequested: true,
        },
      });
      await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'prepare devcontainer execution',
          messageId: 'msg_018f1e2d3c4bDevPlanAbCdEFG',
        })
      );
      await instance.alarm();
      return { capturedPlan };
    });

    expect(result.capturedPlan).toMatchObject({
      workspace: {
        sandboxId: 'dind-abcdef',
        metadata: {
          workspace: {
            sandboxId: 'dind-abcdef',
            devcontainerRequested: true,
          },
        },
      },
    });
  });

  it('queues initiate when direct wrapper acceptance is unavailable', async () => {
    const userId = 'user_exec_plan' as const;
    const sessionId = 'agent_exec_plan' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let capturedPlan: any = null;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          capturedPlan = plan;
          return { messageId: plan.executionId, kiloSessionId: 'kilo_test' };
        },
      };

      const now = Date.now();
      await instance.updateMetadata({
        version: now,
        sessionId,
        userId,
        timestamp: now,
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'do the thing',
        mode: 'code',
        model: 'test-model',
        messageId: 'msg_018f1e2d3c4bInitMsgAbCdEfG',
      });

      const startResult = await instance.admitSubmittedMessage(request);
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, plan: capturedPlan, pending };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.outcome).toBe('queued');
    expect(result.startResult.messageId).toBe('msg_018f1e2d3c4bInitMsgAbCdEfG');
    expect(result.plan).toBeNull();
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe('msg_018f1e2d3c4bInitMsgAbCdEfG');
  });

  // Initial-session workspace prep now runs lazily when the queued message is flushed.

  it('queues follow-up without calling orchestrator inline', async () => {
    const userId = 'user_exec_followup' as const;
    const sessionId = 'agent_exec_followup' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let capturedPlan: any = null;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          capturedPlan = plan;
          return { messageId: plan.executionId, kiloSessionId: 'kilo_test' };
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_test',
        kiloSessionId: '88888888-8888-4888-8888-888888888888',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'followup prompt',
        messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
      });

      const startResult = await instance.admitSubmittedMessage(request);
      const metadata = await instance.getMetadata();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, metadata, plan: capturedPlan, pending };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.messageId).toBe('msg_018f1e2d3c4bAbCdEfGhIjKlMn');
    expect(result.startResult.outcome).toBe('queued');
    expect(result.metadata?.repository?.token).toBe('old-token');
    expect(result.plan).toBeNull();
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe('msg_018f1e2d3c4bAbCdEfGhIjKlMn');
    expect(result.pending[0]?.content).toBe('followup prompt');
    expect(result.pending[0]?.executionId).toBe(result.startResult.executionId);
  });

  it('flushes queued follow-up using the originally queued execution options', async () => {
    const userId = 'user_exec_followup_options' as const;
    const sessionId = 'agent_exec_followup_options' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let capturedPlan: any = null;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          capturedPlan = plan;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: 'org_options',
        kiloSessionId: '78787878-7878-4878-8878-787878787878',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'default-model',
        variant: 'alpha',
        autoCommit: false,
        condenseOnComplete: false,
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });

      const startResult = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'followup prompt',
          mode: 'plan',
          model: 'queued-model',
          variant: 'beta',
          autoCommit: true,
          condenseOnComplete: true,
          messageId: 'msg_018f1e2d3c4bQueueOptAbCdEf',
        })
      );
      const pendingBeforeAlarm = await listPendingSessionMessages(instance.ctx.storage);

      await instance.alarm();

      const pending = await listPendingSessionMessages(instance.ctx.storage);
      const metadata = await instance.getMetadata();
      const acceptedMessages = await listNonTerminalAcceptedMessages(instance.ctx.storage);
      return {
        startResult,
        capturedPlan,
        pendingBeforeAlarm,
        pending,
        metadata,
        acceptedMessages,
      };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.pendingBeforeAlarm).toHaveLength(1);
    expect(result.startResult.outcome).toBe('queued');
    expect(result.pending).toHaveLength(0);
    expect(result.metadata?.repository?.token).toBe('old-token');
    expect(result.acceptedMessages).toHaveLength(1);
    expect(result.acceptedMessages[0]?.messageId).toBe('msg_018f1e2d3c4bQueueOptAbCdEf');
    expect(result.capturedPlan).toMatchObject({
      turn: {
        prompt: 'followup prompt',
        messageId: 'msg_018f1e2d3c4bQueueOptAbCdEf',
      },
      agent: {
        mode: 'plan',
        model: 'queued-model',
        variant: 'beta',
      },
      finalization: {
        autoCommit: true,
        condenseOnComplete: true,
      },
      workspace: {
        metadata: expect.objectContaining({
          repository: expect.objectContaining({ token: 'old-token' }),
        }),
      },
    });
    expect(result.capturedPlan.workspace).not.toHaveProperty('repositoryAuthOverrides');
  });

  it('returns BAD_REQUEST for invalid direct messageId', async () => {
    const userId = 'user_exec_bad_message_id' as const;
    const sessionId = 'agent_exec_bad_message_id' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let capturedPlan: any = null;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          capturedPlan = plan;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '77777777-7777-4777-7777-777777777777',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'followup prompt',
        messageId: 'msg_018F1e2d3c4bAbCdEfGhIjKlMn',
      });

      const startResult = await instance.admitSubmittedMessage(request);
      return { startResult, plan: capturedPlan };
    });

    expect(result.startResult.success).toBe(false);
    if (result.startResult.success) return;

    expect(result.startResult.code).toBe('BAD_REQUEST');
    expect(result.startResult.error).toContain('messageId must match msg_');
    expect(result.plan).toBeNull();
  });

  it('uses the boundary-generated messageId for follow-up execution', async () => {
    const userId = 'user_exec_fallback' as const;
    const sessionId = 'agent_exec_fallback' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let capturedPlan: any = null;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          capturedPlan = plan;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };

      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '99999999-9999-4999-9999-999999999999',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });

      const request = queueUserMessageInput({
        userId,
        prompt: 'followup prompt',
        messageId: 'msg_018f1e2d3c4bBoundMsgAbCdEf',
      });

      const startResult = await instance.admitSubmittedMessage(request);
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, plan: capturedPlan, pending };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.messageId).toBe('msg_018f1e2d3c4bBoundMsgAbCdEf');
    expect(result.startResult.outcome).toBe('queued');
    expect(result.plan).toBeNull();
    expect(result.pending[0]?.messageId).toBe('msg_018f1e2d3c4bBoundMsgAbCdEf');
  });

  it('enforces the pending queue limit without storing an eleventh message', async () => {
    const userId = 'user_exec_queue_full' as const;
    const sessionId = 'agent_exec_queue_full' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '66666666-6666-4666-6666-666666666666',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });

      for (let index = 0; index < 10; index++) {
        await instance.admitSubmittedMessage(
          queueUserMessageInput({
            userId,
            prompt: `queued ${index}`,
            messageId: `msg_018f1e2d3c4b${String(index).padStart(14, 'A')}`,
          })
        );
      }

      const overflowResult = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'queued overflow',
          messageId: 'msg_018f1e2d3c4bOverMsgAbCdEfG',
        })
      );
      const metadata = await instance.getMetadata();
      const duplicateResult = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'queued 0',
          messageId: 'msg_018f1e2d3c4bAAAAAAAAAAAAA0',
        })
      );
      const metadataAfterDuplicate = await instance.getMetadata();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { overflowResult, duplicateResult, metadata, metadataAfterDuplicate, pending };
    });

    expect(result.overflowResult.success).toBe(false);
    if (result.overflowResult.success) return;

    expect(result.overflowResult.code).toBe('PENDING_QUEUE_FULL');
    expect(result.metadata?.repository?.token).toBe('old-token');
    expect(result.duplicateResult.success).toBe(true);
    if (!result.duplicateResult.success) return;
    expect(result.duplicateResult.outcome).toBe('queued');
    expect(result.duplicateResult.messageId).toBe('msg_018f1e2d3c4bAAAAAAAAAAAAA0');
    expect(result.metadataAfterDuplicate?.repository?.token).toBe('old-token');
    expect(result.pending).toHaveLength(10);
    expect(
      result.pending.some(message => message.messageId === 'msg_018f1e2d3c4bOverMsgAbCdEfG')
    ).toBe(false);
  });

  it('queues a prepared-session message without tripping on stale runtime state', async () => {
    const userId = 'user_exec_prepared_stale_active' as const;
    const sessionId = 'agent_exec_prepared_stale_active' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let callCount = 0;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          callCount += 1;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '15151515-1515-4515-9515-151515151515',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-prepared',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
        initialMessageId: 'msg_018f1e2d3c4bPrepStaleAbCdE',
      });
      await instance.ctx.storage.put('wrapper_runtime_state', { wrapperGeneration: 99 });

      const startResult = await instance.admitPreparedInitialMessage(
        queueRegisteredInitialInput({ userId })
      );
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return {
        startResult,
        pending,
        callCount,
        executions: await instance.getExecutions(),
      };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;
    expect(result.startResult.outcome).toBe('queued');
    expect(result.callCount).toBe(0);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe('msg_018f1e2d3c4bPrepStaleAbCdE');
  });

  it('reuses prepared initialMessageId for registered-initial queueing', async () => {
    const userId = 'user_exec_prepared_initial_id' as const;
    const sessionId = 'agent_exec_prepared_initial_id' as const;
    const initialMessageId = 'msg_018f1e2d3c4bPrepInitAbCdEF';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '16161616-1616-4616-9616-161616161616',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-prepared',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
        initialMessageId,
      });

      const firstResult = await instance.admitPreparedInitialMessage(
        queueRegisteredInitialInput({ userId })
      );
      const retryResult = await instance.admitPreparedInitialMessage(
        queueRegisteredInitialInput({ userId })
      );
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { firstResult, retryResult, pending };
    });

    expect(result.firstResult.success).toBe(true);
    expect(result.retryResult.success).toBe(true);
    if (!result.firstResult.success || !result.retryResult.success) return;

    expect(result.firstResult.messageId).toBe(initialMessageId);
    expect(result.retryResult.messageId).toBe(initialMessageId);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe(initialMessageId);
    expect(result.pending[0]?.content).toBe('prepared prompt');
  });

  it('uses the prepared initialMessageId for registered-initial queueing', async () => {
    const userId = 'user_exec_prepared_id_wins' as const;
    const sessionId = 'agent_exec_prepared_id_wins' as const;
    const initialMessageId = 'msg_018f1e2d3c4bPrepWinsAbCdEF';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '17171717-1717-4717-9717-171717171717',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-prepared',
        initialMessageId,
      });

      const startResult = await instance.admitPreparedInitialMessage(
        queueRegisteredInitialInput({ userId })
      );
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, pending };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.messageId).toBe(initialMessageId);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe(initialMessageId);
  });

  it('replays a prepared initial command turn when initiate queues registered initial work', async () => {
    const userId = 'user_exec_prepared_command' as const;
    const sessionId = 'agent_exec_prepared_command' as const;
    const initialMessageId = 'msg_018f1e2d3c4bPrepCmdXAbCdEF';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '18181818-1818-4818-9818-181818181818',
        prompt: '/compact --aggressive',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-prepared',
        initialMessageId,
        initialTurn: {
          type: 'command',
          command: 'compact',
          arguments: '--aggressive',
        },
      });

      const startResult = await instance.admitPreparedInitialMessage(
        queueRegisteredInitialInput({ userId })
      );
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, pending };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;

    expect(result.startResult.messageId).toBe(initialMessageId);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]).toMatchObject({
      messageId: initialMessageId,
      content: '/compact --aggressive',
      intent: {
        turn: {
          type: 'command',
          messageId: initialMessageId,
          command: 'compact',
          arguments: '--aggressive',
        },
      },
    });
  });

  it('queues follow-up for later drain while current fenced wrapper work exists', async () => {
    const userId = 'user_exec_active_followup' as const;
    const sessionId = 'agent_exec_active_followup' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let callCount = 0;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          callCount += 1;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '12121212-1212-4212-9212-121212121212',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn-active-followup',
        wrapperRunId: 'wr-active-followup',
      });

      const startResult = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'queue while active',
          messageId: 'msg_018f1e2d3c4bActQueAbCdEfGh',
        })
      );
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, pending, callCount };
    });

    expect(result.startResult.success).toBe(true);
    if (!result.startResult.success) return;
    expect(result.startResult.outcome).toBe('queued');
    expect(result.callCount).toBe(0);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.messageId).toBe('msg_018f1e2d3c4bActQueAbCdEfGh');
  });

  it('returns durable admission idempotently when retrying an accepted messageId', async () => {
    const userId = 'user_exec_active_retry' as const;
    const sessionId = 'agent_exec_active_retry' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      let callCount = 0;
      (instance as any).orchestrator = {
        execute: async (plan: any) => {
          callCount += 1;
          return { messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' };
        },
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '13131313-1313-4313-9313-131313131313',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });
      await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'accept once',
          messageId: 'msg_018f1e2d3c4bActRetAbCdEfGh',
        })
      );
      await instance.alarm();
      const retryResult = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'accept once',
          messageId: 'msg_018f1e2d3c4bActRetAbCdEfGh',
        })
      );
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { retryResult, pending, callCount };
    });

    expect(result.retryResult.success).toBe(true);
    if (!result.retryResult.success) return;
    expect(result.retryResult.outcome).toBe('queued');
    expect(result.retryResult.compatibilityDelivery).toBe('sent');
    expect(result.pending).toHaveLength(0);
    expect(result.callCount).toBe(1);
  });

  it('does not persist token overrides when model validation fails', async () => {
    const userId = 'user_exec_invalid_model' as const;
    const sessionId = 'agent_exec_invalid_model' as const;
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: '14141414-1414-4414-9414-141414141414',
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-followup',
        gitUrl: 'https://example.com/repo.git',
        gitToken: 'old-token',
      });

      const startResult = await instance.admitSubmittedMessage(
        queueUserMessageInput({
          userId,
          prompt: 'bad model',
          model: '',
          messageId: 'msg_018f1e2d3c4bInvModAbCdEfGh',
        })
      );
      const metadata = await instance.getMetadata();
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      return { startResult, metadata, pending };
    });

    expect(result.startResult.success).toBe(false);
    if (result.startResult.success) return;
    expect(result.startResult.code).toBe('BAD_REQUEST');
    expect(result.metadata?.repository?.token).toBe('old-token');
    expect(result.pending).toHaveLength(0);
  });
});
