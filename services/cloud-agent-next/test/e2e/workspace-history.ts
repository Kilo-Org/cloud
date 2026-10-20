import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { z } from 'zod';
import { createCloudAgentTransport } from '../../../../packages/cloud-agent-sdk/src/cloud-agent-transport.js';
import { createChatProcessor } from '../../../../packages/cloud-agent-sdk/src/chat-processor.js';
import { createMemoryStorage } from '../../../../packages/cloud-agent-sdk/src/storage/memory.js';
import { cloudSessionMessagesPageSchema } from '../../../../packages/cloud-agent-sdk/src/schemas.js';
import type {
  CloudAgentSessionId,
  CloudSessionSnapshotPage,
  KiloSessionId,
} from '../../../../packages/cloud-agent-sdk/src/types.js';
import {
  DRIVER_USER_EMAIL_SUFFIX,
  ensureTestUser,
  loadDevVars,
  loadExistingUserByEmail,
  loadRepoEnvFiles,
} from './auth.js';
import {
  DEFAULT_CONFIG,
  deleteSession,
  fakeDirective,
  fetchFakeRequests,
  getMessageResult,
  interruptSession,
  resolveStreamTicket,
  sendMessage,
  startSession,
  streamEventSchema,
  trpcCall,
  type DriverConfig,
  type StartSessionResult,
} from './client.js';
import {
  findControlPlaneKiloRuntime,
  stopOwnedControlPlaneSandbox,
  waitForSandboxFamilyGone,
} from './sandbox-control.js';
import { createMessageId } from '../../src/session/message-id.js';
import { createNativeHistoryChild } from './workspace-history-native-child.js';

const modeSchema = z.enum(['cold', 'sync', 'interrupt', 'restoration', 'all']);
type Mode = z.infer<typeof modeSchema>;
type Page = CloudSessionSnapshotPage;
type PageOptions = { cursor?: string; limit?: number; kiloSessionId?: string };
const cursorEventSchema = streamEventSchema.extend({
  cursor: z.number().int().nonnegative().optional(),
});
type CursorEvent = z.infer<typeof cursorEventSchema>;
const nativePartSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  messageID: z.string(),
  type: z.literal('text'),
  text: z.string(),
});
const MAX_MODE_MS = 175_000;
const CLEANUP_MS = 25_000;
const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function createDeadline(deadlineAt: number) {
  return {
    async within<T>(
      label: string,
      operation: (signal: AbortSignal) => Promise<T>,
      budgetMs = Number.POSITIVE_INFINITY
    ): Promise<T> {
      const remaining = Math.min(deadlineAt - Date.now(), budgetMs);
      assert.ok(remaining > 0, `Driver deadline exceeded before ${label}`);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation(controller.signal),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`Driver deadline exceeded during ${label}`));
            }, remaining);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function textPart(event: CursorEvent) {
  if (event.streamEventType !== 'kilocode' || event.data.type !== 'message.part.updated') return;
  const properties = z.object({ part: nativePartSchema }).safeParse(event.data.properties);
  return properties.success ? properties.data.part : undefined;
}

function partsDigest(messages: Page['messages']): string {
  const rows = [...messages]
    .sort((left, right) => left.info.id.localeCompare(right.info.id))
    .map(message => ({
      id: message.info.id,
      parts: [...message.parts].sort((left, right) => left.id.localeCompare(right.id)),
    }));
  const canonical = JSON.stringify(rows, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    );
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function stopOwnedSandboxes(entries: Array<[string, string]>): Promise<string[]> {
  const failures: unknown[] = [];
  const discovered = await Promise.all(
    entries.map(async ([, kiloSessionId]) => {
      try {
        return await findControlPlaneKiloRuntime(kiloSessionId);
      } catch (error) {
        failures.push(error);
        return null;
      }
    })
  );
  const runtimes = discovered.filter(runtime => runtime !== null);
  const stopped: string[] = [];
  const containers = new Set<string>();
  await Promise.all(
    runtimes.map(async runtime => {
      if (containers.has(runtime.container.id)) return;
      containers.add(runtime.container.id);
      try {
        const killed = await stopOwnedControlPlaneSandbox(
          runtime.container,
          runtime.kiloSessionId,
          undefined,
          runtimes.map(value => value.directory)
        );
        stopped.push(...killed);
        assert.equal(
          await waitForSandboxFamilyGone(runtime.container, 15_000),
          true,
          'Owned sandbox family did not stop'
        );
      } catch (error) {
        failures.push(error);
      }
    })
  );
  if (failures.length > 0) throw new AggregateError(failures, 'Owned sandbox cleanup failed');
  return stopped;
}

export async function runWorkspaceHistoryAcceptance(
  originalConfig: DriverConfig,
  options: { mode?: Mode; withChild?: boolean; timeoutMs?: number; keepSession?: boolean } = {}
) {
  const mode = options.mode ?? 'all';
  const timeoutMs = options.timeoutMs ?? MAX_MODE_MS;
  assert.ok(
    timeoutMs > CLEANUP_MS && timeoutMs <= MAX_MODE_MS,
    'Mode budget must be between 25s and 175s'
  );
  assert.equal(
    originalConfig.model,
    DEFAULT_CONFIG.model,
    'Only kilo/fake-deterministic is allowed'
  );
  for (const base of [originalConfig.workerUrl, originalConfig.fakeLlmUrl]) {
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname),
      'This driver is local-stack only'
    );
  }
  const startedAt = Date.now();
  const deadline = createDeadline(startedAt + timeoutMs - CLEANUP_MS);
  const owned = new Map<string, string>();
  const streams = new Set<{ close(): Promise<void> }>();
  const clients = new Set<{ destroy(): void }>();
  const checks: string[] = [];
  const evidence: Record<string, string | number> = {};
  let legacyHistoryReads = 0;
  let acceptanceFailed = false;
  const config: DriverConfig = {
    ...originalConfig,
    expectControlPlane: true,
    onSessionCreated(sessionId, kiloSessionId) {
      owned.set(sessionId, kiloSessionId);
      originalConfig.onSessionCreated?.(sessionId, kiloSessionId);
    },
  };

  async function poll<T>(
    label: string,
    read: (signal: AbortSignal) => T | undefined | Promise<T | undefined>
  ): Promise<T> {
    return deadline.within(label, async signal => {
      while (true) {
        signal.throwIfAborted();
        const value = await read(signal);
        if (value !== undefined) return value;
        await delay(100, undefined, { signal });
      }
    });
  }

  async function readPage(root: StartSessionResult, pageOptions: PageOptions = {}): Promise<Page> {
    const value = await deadline.within('getSessionMessagesPage', signal =>
      trpcCall<unknown>(
        config,
        'getSessionMessagesPage',
        {
          sessionId: root.cloudAgentSessionId,
          ...pageOptions,
        },
        { method: 'GET', signal }
      )
    );
    const page = cloudSessionMessagesPageSchema.parse(value);
    assert.ok(page, 'Owned DO history returned null');
    assert.equal(
      page.info.id,
      pageOptions.kiloSessionId ?? root.kiloSessionId,
      'DO returned another native session'
    );
    assert.equal(page.omittedItemCount, 0, 'Small deterministic history omitted native data');
    return page;
  }

  async function completed(root: StartSessionResult, messageId: string): Promise<void> {
    await poll('durable turn completion', async signal => {
      const result = await getMessageResult(config, root.cloudAgentSessionId, messageId, signal);
      if (result.status === 'queued' || result.status === 'running') return;
      assert.equal(result.status, 'completed', 'Native turn did not complete');
      return true;
    });
  }

  async function pagination(root: StartSessionResult, kiloSessionId?: string): Promise<Page> {
    const selector = kiloSessionId ? { kiloSessionId } : {};
    const full = await readPage(root, { ...selector, limit: 100 });
    assert.equal(full.nextCursor, null, 'Fixture unexpectedly exceeded 100 messages');
    assert.ok(full.messages.length >= 2, 'Fixture needs both a user and assistant message');
    const pages: Page['messages'] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await readPage(root, { ...selector, limit: 1, ...(cursor ? { cursor } : {}) });
      assert.equal(page.messages.length, 1, 'limit=1 did not return one native message');
      assert.ok(page.updateCursor >= full.updateCursor, 'Page watermark moved backwards');
      assert.equal(
        page.totalCostMicrodollars,
        full.totalCostMicrodollars,
        'Cost must not depend on page size'
      );
      pages.unshift(...page.messages);
      cursor = page.nextCursor ?? undefined;
      if (cursor) {
        assert.equal(cursors.has(cursor), false, 'Pagination cursor did not advance');
        cursors.add(cursor);
      }
      assert.ok(cursors.size < 32, 'Fixture pagination exceeded its bounded page count');
    } while (cursor);
    assert.equal(
      new Set(pages.map(message => message.info.id)).size,
      pages.length,
      'Pagination repeated a native message'
    );
    assert.deepEqual(
      pages.map(message => message.info.id),
      full.messages.map(message => message.info.id),
      'Paged chronology differs from the complete DO snapshot'
    );
    assert.equal(
      partsDigest(pages),
      partsDigest(full.messages),
      'Pagination changed final native parts'
    );
    return full;
  }

  async function openCursorStream(root: StartSessionResult, afterCursor: number) {
    const ticket = await resolveStreamTicket(config, root.cloudAgentSessionId);
    const url = new URL('/stream', config.workerUrl.replace(/^http/, 'ws'));
    url.searchParams.set('cloudAgentSessionId', root.cloudAgentSessionId);
    url.searchParams.set('ticket', ticket);
    url.searchParams.set('bootstrap', 'true');
    url.searchParams.set('afterCursor', String(afterCursor));
    const socket = new WebSocket(url);
    const events: CursorEvent[] = [];
    let failure: string | undefined;
    socket.on('error', () => {
      failure = 'Cursor stream connection failed';
    });
    socket.on('message', data => {
      try {
        const text =
          data instanceof ArrayBuffer
            ? Buffer.from(data).toString('utf8')
            : Array.isArray(data)
              ? Buffer.concat(data).toString('utf8')
              : data.toString('utf8');
        const value: unknown = JSON.parse(text);
        const parsed = cursorEventSchema.safeParse(value);
        if (parsed.success) events.push(parsed.data);
        else failure = 'Cursor stream returned an invalid frame';
      } catch {
        failure = 'Cursor stream returned invalid JSON';
      }
    });
    const stream = {
      events,
      waitFor: (label: string, predicate: (event: CursorEvent) => boolean) =>
        poll(label, () => {
          if (failure) throw new Error(failure);
          const found = events.find(predicate);
          if (found) return found;
          assert.notEqual(
            socket.readyState,
            WebSocket.CLOSED,
            'Cursor stream closed before the expected frame'
          );
        }),
      close: () =>
        new Promise<void>(resolve => {
          if (socket.readyState === WebSocket.CLOSED) return resolve();
          const timer = setTimeout(() => {
            socket.terminate();
            resolve();
          }, 500);
          socket.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          socket.close();
        }),
    };
    streams.add(stream);
    await stream.waitFor(
      'cursor stream bootstrap',
      event => event.streamEventType === 'bootstrap.complete'
    );
    return stream;
  }

  async function attachSdk(root: StartSessionResult) {
    const storage = createMemoryStorage();
    const processor = createChatProcessor(storage);
    let replayCount = 0;
    let pageReads = 0;
    let chatEvents = 0;
    let sdkFailure = false;
    let hide: (() => void) | undefined;
    let resume: (() => void) | undefined;
    const forbiddenHistoryRead = async (): Promise<never> => {
      legacyHistoryReads += 1;
      throw new Error('Workspace SDK must never read client ingest history');
    };
    const unusedMutation = async (): Promise<never> => {
      throw new Error('Unexpected SDK mutation');
    };
    const transport = createCloudAgentTransport({
      sessionId: root.cloudAgentSessionId as CloudAgentSessionId,
      kiloSessionId: root.kiloSessionId as KiloSessionId,
      websocketBaseUrl: config.workerUrl.replace(/^http/, 'ws'),
      getTicket: sessionId => resolveStreamTicket(config, sessionId),
      fetchSnapshot: forbiddenHistoryRead,
      fetchSnapshotPage: forbiddenHistoryRead,
      fetchCloudSnapshotPage: async (sessionId, pageOptions) => {
        assert.equal(
          sessionId,
          root.cloudAgentSessionId,
          'SDK changed workspace DO while reading history'
        );
        pageReads += 1;
        return readPage(root, pageOptions);
      },
      api: {
        send: input => {
          assert.equal(input.payload.type, 'prompt');
          if (input.payload.type !== 'prompt')
            throw new Error('Only prompt turns belong to this fixture');
          const prompt = input.payload.prompt;
          return deadline.within('SDK send', signal =>
            sendMessage(config, {
              cloudAgentSessionId: input.sessionId,
              prompt,
              messageId: input.messageId,
              signal,
            })
          );
        },
        interrupt: input =>
          deadline.within('SDK interrupt', signal =>
            interruptSession(config, input.sessionId, signal)
          ),
        answer: unusedMutation,
        reject: unusedMutation,
        respondToPermission: unusedMutation,
      },
      onError: () => {
        sdkFailure = true;
      },
      lifecycleHooks: {
        hiddenPauseDelayMs: 0,
        onVisibilityChange(onResume, onHidden) {
          resume = onResume;
          hide = onHidden;
          return () => {
            resume = undefined;
            hide = undefined;
          };
        },
      },
    })({
      onChatEvent(event) {
        chatEvents += 1;
        processor.process(event);
      },
      onServiceEvent(event) {
        if (event.type === 'session.error') sdkFailure = true;
      },
      onReplayComplete() {
        replayCount += 1;
      },
    });
    clients.add(transport);
    transport.connect();
    await poll('actual SDK bootstrap', () => {
      assert.equal(sdkFailure, false, 'Actual SDK reported a transport error');
      return replayCount > 0 ? true : undefined;
    });
    return {
      transport,
      storage,
      get pageReads() {
        return pageReads;
      },
      get chatEvents() {
        return chatEvents;
      },
      get replayCount() {
        return replayCount;
      },
      pause() {
        assert.ok(hide, 'SDK did not install visibility hooks');
        hide();
      },
      resume() {
        assert.ok(resume, 'SDK did not install visibility hooks');
        resume();
      },
      digest() {
        assert.equal(sdkFailure, false, 'Actual SDK reported a transport error');
        return partsDigest(
          storage.getMessageIds().flatMap(id => {
            const info = storage.getMessageInfo(id);
            return info?.sessionID === root.kiloSessionId
              ? [{ info, parts: [...storage.getParts(id)] }]
              : [];
          })
        );
      },
    };
  }

  try {
    const initialRequests = await deadline.within('fake inference baseline', signal =>
      fetchFakeRequests(config.fakeLlmUrl, signal)
    );
    const root = await deadline.within('start real workspace', signal =>
      startSession(config, {
        prompt: fakeDirective('echo:history-bootstrap'),
        signal,
      })
    );
    evidence.sessionId = root.cloudAgentSessionId;
    await completed(root, root.messageId);
    await poll('root native assistant persisted in DO', async () => {
      const page = await readPage(root);
      return page.messages.some(
        message =>
          message.info.role === 'assistant' &&
          message.info.parentID === root.messageId &&
          message.parts.some(part => part.type === 'text' && part.text === 'history-bootstrap')
      )
        ? true
        : undefined;
    });
    const runtime = await deadline.within(
      'prove real owned Kilo runtime',
      () => findControlPlaneKiloRuntime(root.kiloSessionId),
      20_000
    );
    assert.ok(runtime, 'No real owned sandbox/Kilo listener was found');
    const requests = await deadline.within('prove fake inference request', signal =>
      fetchFakeRequests(config.fakeLlmUrl, signal)
    );
    assert.ok(
      requests.chatCompletions > initialRequests.chatCompletions,
      'The real Kilo turn did not reach fake inference'
    );
    const initialSnapshot = await readPage(root);
    const initialSdk = await attachSdk(root);
    assert.equal(
      initialSdk.digest(),
      partsDigest(initialSnapshot.messages),
      'Actual SDK bootstrap differs from the root DO snapshot'
    );
    initialSdk.transport.destroy();
    checks.push(
      'real-worker-do-sandbox-kilo-fake-inference',
      'root-history-from-do',
      'actual-sdk-bootstrap-from-do'
    );

    if (mode === 'cold' || mode === 'all') {
      const followup = await deadline.within('pagination follow-up', signal =>
        sendMessage(config, {
          cloudAgentSessionId: root.cloudAgentSessionId,
          prompt: fakeDirective('echo:history-second'),
          signal,
        })
      );
      await completed(root, followup.messageId);
      await pagination(root);
      checks.push('root-pagination-no-gaps-or-duplicates');
      const firstPage = await readPage(root, { limit: 1 });
      assert.ok(firstPage.nextCursor, 'Root fixture did not produce an older-page cursor');
      const query = new URL('/trpc/getSessionMessagesPage', config.workerUrl);
      query.searchParams.set('input', JSON.stringify({ sessionId: root.cloudAgentSessionId }));
      const unauthenticated = await deadline.within('missing-auth rejection', signal =>
        fetch(query, { signal })
      );
      assert.equal(unauthenticated.status, 401, 'History accepted a missing bearer');
      await unauthenticated.body?.cancel();
      await deadline.within('invalid-auth rejection', signal =>
        assert.rejects(
          trpcCall(
            { ...config, bearerToken: 'invalid-e2e-token' },
            'getSessionMessagesPage',
            { sessionId: root.cloudAgentSessionId },
            { method: 'GET', signal }
          ),
          /401/
        )
      );
      const stranger = await deadline.within('foreign local test user', () =>
        ensureTestUser(
          process.env.DATABASE_URL,
          `history-stranger-${randomUUID()}${DRIVER_USER_EMAIL_SUFFIX}`
        )
      );
      await deadline.within('foreign-owner rejection', signal =>
        assert.rejects(
          trpcCall(
            { ...config, user: stranger, bearerToken: undefined },
            'getSessionMessagesPage',
            { sessionId: root.cloudAgentSessionId },
            { method: 'GET', signal }
          ),
          /403/
        )
      );
      const other = await deadline.within('second owned workspace', signal =>
        startSession(config, {
          prompt: fakeDirective('echo:history-other-root'),
          signal,
        })
      );
      await completed(other, other.messageId);
      await readPage(other);
      await deadline.within('cross-workspace cursor rejection', signal =>
        assert.rejects(
          trpcCall(
            config,
            'getSessionMessagesPage',
            { sessionId: other.cloudAgentSessionId, cursor: firstPage.nextCursor },
            { method: 'GET', signal }
          ),
          /400.*BAD_REQUEST/
        )
      );
      const foreignSelector = await deadline.within('unrelated-native selector rejection', signal =>
        trpcCall<unknown>(
          config,
          'getSessionMessagesPage',
          { sessionId: root.cloudAgentSessionId, kiloSessionId: other.kiloSessionId },
          { method: 'GET', signal }
        )
      );
      assert.equal(foreignSelector, null, 'Root DO exposed another workspace native root');
      checks.push(
        'missing-invalid-foreign-auth-rejected',
        'cross-workspace-cursor-and-native-selector-rejected'
      );
    }

    if (options.withChild) {
      const childId = await deadline.within(
        'real native child turn',
        () =>
          createNativeHistoryChild({
            runtime,
            model: config.model,
            prompt: fakeDirective('echo:history-child'),
          }),
        30_000
      );
      await poll('child native history in root DO', async signal => {
        const value = await trpcCall<unknown>(
          config,
          'getSessionMessagesPage',
          {
            sessionId: root.cloudAgentSessionId,
            kiloSessionId: childId,
          },
          { method: 'GET', signal }
        );
        const page = cloudSessionMessagesPageSchema.parse(value);
        if (!page) return;
        assert.equal(page.omittedItemCount, 0, 'Small native child history omitted data');
        assert.equal(page.info.parentID, root.kiloSessionId, 'Child history lost native lineage');
        return page.messages.some(
          message =>
            message.info.role === 'assistant' &&
            message.parts.some(part => part.type === 'text' && part.text === 'history-child')
        )
          ? true
          : undefined;
      });
      await pagination(root, childId);
      const rootCursor = (await readPage(root, { limit: 1 })).nextCursor;
      const childCursor = (await readPage(root, { kiloSessionId: childId, limit: 1 })).nextCursor;
      assert.ok(rootCursor && childCursor, 'Root and child need independent history cursors');
      for (const selector of [
        { cursor: rootCursor, kiloSessionId: childId },
        { cursor: childCursor },
      ]) {
        await deadline.within('cross-native cursor rejection', signal =>
          assert.rejects(
            trpcCall(
              config,
              'getSessionMessagesPage',
              { sessionId: root.cloudAgentSessionId, ...selector },
              { method: 'GET', signal }
            ),
            /400.*BAD_REQUEST/
          )
        );
      }
      checks.push(
        'real-native-child-loaded-through-root-do',
        'child-pagination-and-cursor-isolation'
      );
    }

    if (mode === 'sync' || mode === 'all') {
      const baseline = await readPage(root);
      const live = await attachSdk(root);
      const initial = await openCursorStream(root, baseline.updateCursor);
      const previousMessageIds = new Set(baseline.messages.map(message => message.info.id));
      const messageId = createMessageId();
      const send = live.transport.send;
      assert.ok(send, 'Actual Cloud Agent SDK transport cannot send');
      const sending = send({
        messageId,
        payload: {
          type: 'prompt',
          prompt: fakeDirective('slow:32:500:16'),
          mode: 'code',
          model: { providerID: 'kilo', modelID: config.model },
        },
      });
      void sending.catch(() => undefined);
      const first = await initial.waitFor('initial live text state', event => {
        const part = textPart(event);
        return (
          part?.sessionID === root.kiloSessionId &&
          part.messageID !== messageId &&
          !previousMessageIds.has(part.messageID) &&
          part.text.length > 0
        );
      });
      const firstPart = textPart(first);
      assert.ok(firstPart && first.cursor !== undefined && first.eventId > 0);
      const next = await initial.waitFor('same-row newer live state', event => {
        const part = textPart(event);
        return (
          part?.id === firstPart.id &&
          part.text.length > firstPart.text.length &&
          (event.cursor ?? 0) > (first.cursor ?? 0)
        );
      });
      assert.equal(next.eventId, first.eventId, 'Text update changed its stable persisted row ID');
      const partial = textPart(next);
      assert.ok(
        partial && partial.text.length > 0 && partial.text.length < 512,
        'Disconnect checkpoint did not hold partial streamed text'
      );
      const savedCursor = Math.max(...initial.events.map(event => event.cursor ?? 0));
      const savedEventId = Math.max(...initial.events.map(event => event.eventId));
      live.pause();
      await initial.close();
      await deadline.within('SDK hidden socket closure', signal =>
        delay(100, undefined, { signal })
      );
      const pausedEvents = live.chatEvents;
      const sdkPageReads = live.pageReads;
      const sdkReplays = live.replayCount;
      await sending;
      await completed(root, messageId);
      const final = await readPage(root, { limit: 100 });
      assert.ok(
        final.messages.some(
          message =>
            message.info.id === firstPart.messageID &&
            message.info.role === 'assistant' &&
            message.info.parentID === messageId
        ),
        'Observed stream did not belong to the submitted Cloud message'
      );
      const finalPart = final.messages
        .flatMap(message => message.parts)
        .find(part => part.id === firstPart.id);
      assert.ok(finalPart?.type === 'text');
      const expectedText = Array.from({ length: 32 }, (_, index) => {
        const token = ` w${index} `;
        return token.repeat(Math.ceil(16 / token.length)).slice(0, 16);
      }).join('');
      assert.equal(
        finalPart.text,
        expectedText,
        'Final DO text differs from deterministic inference'
      );
      assert.equal(
        live.chatEvents,
        pausedEvents,
        'SDK was not actually disconnected during the gap'
      );
      assert.notEqual(
        live.digest(),
        partsDigest(final.messages),
        'SDK received the final streamed state before disconnecting'
      );
      const catchup = await openCursorStream(root, savedCursor);
      const replayed = catchup.events.find(event => textPart(event)?.id === firstPart.id);
      assert.ok(replayed, 'afterCursor omitted the mutated older row');
      assert.equal(replayed.eventId, first.eventId, 'Catch-up rewrote the older row identity');
      assert.ok(
        replayed.eventId <= savedEventId,
        'Catch-up only proved replay of a newly inserted row'
      );
      assert.ok(
        (replayed.cursor ?? 0) > savedCursor,
        'Catch-up did not advance beyond the saved mutation cursor'
      );
      assert.equal(textPart(replayed)?.text, expectedText, 'afterCursor replayed stale text');
      live.resume();
      await poll('actual SDK cursor reconnect parity', () =>
        live.replayCount > sdkReplays && live.digest() === partsDigest(final.messages)
          ? true
          : undefined
      );
      assert.equal(
        live.pageReads,
        sdkPageReads,
        'SDK reconnect fetched a new snapshot instead of afterCursor catch-up'
      );
      const reloaded = await attachSdk(root);
      assert.equal(
        reloaded.digest(),
        live.digest(),
        'Reload snapshot differs from caught-up SDK final parts'
      );
      evidence.stableEventId = first.eventId;
      evidence.firstCursor = first.cursor;
      evidence.savedCursor = savedCursor;
      evidence.catchupCursor = replayed.cursor ?? 0;
      evidence.finalPartsSha256 = partsDigest(final.messages);
      checks.push(
        'same-row-event-id-stable-cursor-advances',
        'disconnected-after-cursor-replays-newer-older-row',
        'actual-sdk-reconnect-without-snapshot-refetch',
        'reload-final-parts-match-live-sdk'
      );
    }

    if (mode === 'interrupt' || mode === 'all') {
      const snapshot = await readPage(root);
      const control = await attachSdk(root);
      const stream = await openCursorStream(root, snapshot.updateCursor);
      const requestsBefore = await deadline.within('pre-interrupt inference count', signal =>
        fetchFakeRequests(config.fakeLlmUrl, signal)
      );
      const message = { messageId: createMessageId() };
      const submitting = deadline.within('start interruptible turn', signal =>
        sendMessage(config, {
          cloudAgentSessionId: root.cloudAgentSessionId,
          messageId: message.messageId,
          prompt: fakeDirective('slow:100:500:16'),
          signal,
        })
      );
      void submitting.catch(() => undefined);
      await poll('interruptible native turn running', async signal => {
        const result = await getMessageResult(
          config,
          root.cloudAgentSessionId,
          message.messageId,
          signal
        ).catch((error: unknown) => {
          if (error instanceof Error && /404.*NOT_FOUND/.test(error.message)) return null;
          throw error;
        });
        if (result === null) return;
        assert.equal(result.status === 'completed', false, 'Interruptible turn completed too soon');
        if (result.status !== 'running') return;
        const current = await fetchFakeRequests(config.fakeLlmUrl, signal);
        return current.chatCompletions > requestsBefore.chatCompletions ? true : undefined;
      });
      const interrupt = control.transport.interrupt;
      assert.ok(interrupt, 'Actual SDK transport cannot interrupt');
      await interrupt();
      await submitting;
      await stream.waitFor('durable interrupted outcome', event => {
        if (event.streamEventType !== 'cloud.message.failed') return false;
        const failure = z
          .object({ messageId: z.string(), reason: z.string() })
          .safeParse(event.data);
        return (
          failure.success &&
          failure.data.messageId === message.messageId &&
          failure.data.reason === 'interrupted'
        );
      });
      await poll('interrupted turn terminal', async signal => {
        const result = await getMessageResult(
          config,
          root.cloudAgentSessionId,
          message.messageId,
          signal
        );
        return result.status === 'failed' || result.status === 'interrupted' ? true : undefined;
      });
      const followup = await deadline.within('follow-up after SDK interrupt', signal =>
        sendMessage(config, {
          cloudAgentSessionId: root.cloudAgentSessionId,
          prompt: fakeDirective('echo:history-after-interrupt'),
          signal,
        })
      );
      await completed(root, followup.messageId);
      const continued = await readPage(root);
      assert.ok(
        continued.messages.some(
          message =>
            message.info.role === 'assistant' &&
            message.info.parentID === followup.messageId &&
            message.parts.some(
              part => part.type === 'text' && part.text === 'history-after-interrupt'
            )
        ),
        'Follow-up did not preserve the same native conversation'
      );
      const recovered = await deadline.within(
        'same native sandbox after interrupt',
        () => findControlPlaneKiloRuntime(root.kiloSessionId),
        15_000
      );
      assert.equal(
        recovered?.container.id,
        runtime.container.id,
        'Interrupt replaced the native sandbox'
      );
      checks.push(
        'actual-sdk-interrupt-confirmed-durably',
        'follow-up-completes-in-same-native-sandbox'
      );
    }

    if (mode === 'restoration' || mode === 'all') {
      for (const client of clients) client.destroy();
      const warm = await pagination(root);
      const before = await deadline.within('pre-cold fake count', signal =>
        fetchFakeRequests(config.fakeLlmUrl, signal)
      );
      const stopped = await deadline.within(
        'stop only owned sandbox',
        () => stopOwnedSandboxes([...owned]),
        20_000
      );
      assert.ok(stopped.length > 0, 'Restoration did not actually stop a live sandbox');
      const cold = await pagination(root);
      assert.equal(
        partsDigest(cold.messages),
        partsDigest(warm.messages),
        'Cold DO snapshot changed final parts'
      );
      const reloaded = await attachSdk(root);
      assert.equal(
        reloaded.digest(),
        partsDigest(warm.messages),
        'Cold actual SDK bootstrap differs from warm DO parts'
      );
      const after = await deadline.within('post-cold fake count', signal =>
        fetchFakeRequests(config.fakeLlmUrl, signal)
      );
      assert.equal(
        after.chatCompletions,
        before.chatCompletions,
        'Reading cold history unexpectedly requested inference'
      );
      const coldRuntime = await deadline.within(
        'cold reads did not wake Kilo',
        () => findControlPlaneKiloRuntime(root.kiloSessionId),
        15_000
      );
      assert.equal(coldRuntime, null, 'Cold history reads restarted the sandbox/Kilo listener');
      checks.push(
        'cold-do-pagination-survives-sandbox-stop',
        'cold-sdk-bootstrap-without-sandbox-or-inference'
      );
    }
    assert.equal(legacyHistoryReads, 0, 'Workspace SDK called a client ingest history callback');
    checks.push('zero-client-ingest-history-reads');
    return { mode, checks, evidence, legacyHistoryReads, durationMs: Date.now() - startedAt };
  } catch (error) {
    acceptanceFailed = true;
    throw error;
  } finally {
    for (const client of clients) client.destroy();
    await Promise.all([...streams].map(stream => stream.close()));
    const cleanup = createDeadline(Math.min(Date.now() + CLEANUP_MS, startedAt + timeoutMs));
    for (const [sessionId] of [...owned].reverse()) {
      await cleanup
        .within(
          'interrupt owned session',
          signal => interruptSession(config, sessionId, signal),
          3_000
        )
        .catch(() => undefined);
    }
    let cleanupFailed = false;
    await cleanup
      .within('reclaim owned sandboxes', () => stopOwnedSandboxes([...owned]))
      .catch(() => {
        cleanupFailed = true;
      });
    for (const [sessionId] of options.keepSession ? [] : [...owned].reverse()) {
      await cleanup
        .within('delete owned session', signal => deleteSession(config, sessionId, signal), 3_000)
        .catch(() => {
          console.warn(
            'workspace-history: owned DO deletion did not finish within the cleanup budget'
          );
        });
    }
    if (cleanupFailed && acceptanceFailed) {
      console.warn(
        'workspace-history: safe owned-sandbox cleanup also failed or exceeded its budget'
      );
    } else {
      assert.equal(cleanupFailed, false, 'Owned sandbox cleanup failed or exceeded its budget');
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(
      'Usage: pnpm exec tsx services/cloud-agent-next/test/e2e/workspace-history.ts [cold|sync|interrupt|restoration|all] [--child]'
    );
    console.log(
      'Existing local stack only. Set WORKER_URL and FAKE_LLM_URL to the discovered ports. Optional E2E_GIT_URL and E2E_USER_EMAIL. Each mode is capped at 175s including cleanup.'
    );
    return;
  }
  const withChild = args.includes('--child');
  const positional = args.filter(arg => arg !== '--child');
  assert.ok(positional.length <= 1, 'Expected one mode and optional --child');
  const mode = modeSchema.parse(positional[0] ?? 'all');
  const startedAt = Date.now();
  setTimeout(() => {
    console.error('workspace-history: hard 179s driver deadline exceeded');
    process.exit(1);
  }, 179_000).unref();
  loadRepoEnvFiles(SERVICE_DIR);
  const devVars = loadDevVars(SERVICE_DIR);
  process.env.E2E_FAKE_SCOPE ??= `history-${randomUUID()}`;
  if (!process.env.FAKE_LLM_ADMIN_TOKEN && devVars.FAKE_LLM_ADMIN_TOKEN) {
    process.env.FAKE_LLM_ADMIN_TOKEN = devVars.FAKE_LLM_ADMIN_TOKEN;
  }
  const user = process.env.E2E_USER_EMAIL
    ? await loadExistingUserByEmail(process.env.DATABASE_URL, process.env.E2E_USER_EMAIL)
    : await ensureTestUser(
        process.env.DATABASE_URL,
        `history-${randomUUID()}${DRIVER_USER_EMAIL_SUFFIX}`,
        { funded: true }
      );
  const report = await runWorkspaceHistoryAcceptance(
    {
      ...DEFAULT_CONFIG,
      workerUrl: process.env.WORKER_URL ?? DEFAULT_CONFIG.workerUrl,
      fakeLlmUrl: process.env.FAKE_LLM_URL ?? DEFAULT_CONFIG.fakeLlmUrl,
      gitUrl: process.env.E2E_GIT_URL ?? DEFAULT_CONFIG.gitUrl,
      model: process.env.E2E_MODEL ?? DEFAULT_CONFIG.model,
      user,
      nextAuthSecret: devVars.NEXTAUTH_SECRET,
      internalApiSecret: devVars.INTERNAL_API_SECRET,
    },
    {
      mode,
      withChild,
      keepSession: process.env.E2E_KEEP_SESSION === '1',
      timeoutMs: Math.min(MAX_MODE_MS, 178_000 - (Date.now() - startedAt)),
    }
  );
  console.log(JSON.stringify({ result: 'pass', ...report, durationMs: Date.now() - startedAt }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(
      `workspace-history: ${error instanceof Error ? error.message : 'acceptance failed'}`
    );
    process.exitCode = 1;
  });
}
