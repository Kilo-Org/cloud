import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

import {
  decodeKiloSdkMessagesCursor,
  MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE,
} from '@kilocode/session-ingest-contracts';
import {
  KILO_SDK_HISTORY_BOUNDED_MESSAGE_SCAN_ROW_WORK_CAP,
  MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES,
  MAX_KILO_SDK_SESSION_SNAPSHOT_BYTES,
} from '../../src/dos/kilo-sdk-materialization';

function getStub(kiloUserId: string, sessionId: string) {
  const doKey = `${kiloUserId}/${sessionId}`;
  const id = env.SESSION_INGEST_DO.idFromName(doKey);
  return env.SESSION_INGEST_DO.get(id);
}

describe('SessionIngestDO integration', () => {
  const kiloUserId = 'usr_test_integration';

  describe('ingest + getAllStream round-trip', () => {
    it('ingests a single session item and exports it', async () => {
      const sessionId = 'ses_roundtrip_single_000000001';
      const stub = getStub(kiloUserId, sessionId);

      await stub.ingest(
        [{ type: 'session', data: { title: 'Test Session' } }],
        kiloUserId,
        sessionId,
        1
      );

      const raw = await stub.getAllStream().then(s => new Response(s).text());
      const snapshot = JSON.parse(raw);

      expect(snapshot.info).toEqual({ title: 'Test Session' });
      expect(snapshot.messages).toEqual([]);
    });

    it('ingests multiple items and exports a full snapshot', async () => {
      const sessionId = 'ses_roundtrip_multi_000000002';
      const stub = getStub(kiloUserId, sessionId);

      await stub.ingest(
        [
          { type: 'session', data: { title: 'Multi Item Session' } },
          { type: 'message', data: { id: 'msg_1', role: 'user', content: 'hello' } },
          {
            type: 'part',
            data: { id: 'part_1', messageID: 'msg_1', type: 'text', content: 'hello' },
          },
          { type: 'message', data: { id: 'msg_2', role: 'assistant', content: 'hi' } },
          {
            type: 'part',
            data: { id: 'part_2', messageID: 'msg_2', type: 'text', content: 'hi' },
          },
        ],
        kiloUserId,
        sessionId,
        1
      );

      const raw = await stub.getAllStream().then(s => new Response(s).text());
      const snapshot = JSON.parse(raw);

      expect(snapshot.info).toEqual({ title: 'Multi Item Session' });
      expect(snapshot.messages).toHaveLength(2);
      expect(snapshot.messages[0].info.id).toBe('msg_1');
      expect(snapshot.messages[0].parts).toHaveLength(1);
      expect(snapshot.messages[0].parts[0].id).toBe('part_1');
      expect(snapshot.messages[1].info.id).toBe('msg_2');
      expect(snapshot.messages[1].parts).toHaveLength(1);
    });

    it('handles multiple ingest calls (appending items)', async () => {
      const sessionId = 'ses_roundtrip_append_00000003';
      const stub = getStub(kiloUserId, sessionId);

      // First ingest: session info + first message
      await stub.ingest(
        [
          { type: 'session', data: { title: 'Incremental Session' } },
          { type: 'message', data: { id: 'msg_1', role: 'user', content: 'first' } },
        ],
        kiloUserId,
        sessionId,
        1
      );

      // Second ingest: second message
      await stub.ingest(
        [{ type: 'message', data: { id: 'msg_2', role: 'assistant', content: 'second' } }],
        kiloUserId,
        sessionId,
        1
      );

      const raw = await stub.getAllStream().then(s => new Response(s).text());
      const snapshot = JSON.parse(raw);

      expect(snapshot.messages).toHaveLength(2);
      expect(snapshot.messages[0].info.id).toBe('msg_1');
      expect(snapshot.messages[1].info.id).toBe('msg_2');
    });
  });

  describe('SDK session snapshot reads', () => {
    it('distinguishes pending snapshots from exact materialized SDK sessions', async () => {
      const sessionId = 'ses_sdk_snapshot_00000000001';
      const stub = getStub(kiloUserId, sessionId);
      const sdkSession = {
        id: sessionId,
        slug: 'quiet-forest',
        projectID: 'project-cloud-agent',
        directory: '/workspace/cloud-agent',
        title: 'SDK attach session',
        version: '7.2.52',
        time: { created: 1761000000000, updated: 1761000001000 },
      };

      expect(await stub.readKiloSdkSessionSnapshot()).toEqual({ kind: 'pending' });

      await stub.ingest([{ type: 'session', data: sdkSession }], kiloUserId, sessionId, 1);

      expect(await stub.readKiloSdkSessionSnapshot()).toEqual({
        kind: 'value',
        info: sdkSession,
        byteLength: new TextEncoder().encode(JSON.stringify(sdkSession)).byteLength,
      });
    });

    it('returns invalid_data for malformed persisted SDK session snapshots', async () => {
      const sessionId = 'ses_sdk_snapshot_invalid_000001';
      const stub = getStub(kiloUserId, sessionId);
      const r2Key = `items/${kiloUserId}/${sessionId}/session/invalid`;
      await env.SESSION_INGEST_R2.put(r2Key, 'not-json');
      await stub.ingest(
        [{ type: 'session', data: { title: 'not-used' } }],
        kiloUserId,
        sessionId,
        1,
        1000,
        { session: r2Key }
      );

      expect(await stub.readKiloSdkSessionSnapshot()).toEqual({ kind: 'invalid_data' });
    });

    it('bounds R2-backed SDK session snapshots using metadata before body hydration', async () => {
      const sessionId = 'ses_sdk_snapshot_bounded_00001';
      const stub = getStub(kiloUserId, sessionId);
      const r2Key = `items/${kiloUserId}/${sessionId}/session/oversized`;
      const oversizedData = JSON.stringify({
        title: 'x'.repeat(MAX_KILO_SDK_SESSION_SNAPSHOT_BYTES),
      });
      await env.SESSION_INGEST_R2.put(r2Key, oversizedData);
      await stub.ingest(
        [{ type: 'session', data: { title: 'not-used' } }],
        kiloUserId,
        sessionId,
        1,
        1000,
        { session: r2Key }
      );

      expect(await stub.readKiloSdkSessionSnapshot()).toEqual({
        kind: 'too_large',
        maximumBytes: MAX_KILO_SDK_SESSION_SNAPSHOT_BYTES,
      });
    });

    it('returns a deliberate retryable failure for a missing R2 snapshot reference', async () => {
      const sessionId = 'ses_sdk_snapshot_missing_00001';
      const stub = getStub(kiloUserId, sessionId);
      await stub.ingest(
        [{ type: 'session', data: { title: 'not-used' } }],
        kiloUserId,
        sessionId,
        1,
        1000,
        { session: `items/${sessionId}/missing` }
      );

      expect(await stub.readKiloSdkSessionSnapshot()).toEqual({
        kind: 'retryable_failure',
      });
    });
  });

  describe('SDK message transcript reads', () => {
    it('returns the complete stored SDK message transcript when no page limit is set', async () => {
      const sessionId = 'ses_sdk_messages_00000000001';
      const stub = getStub(kiloUserId, sessionId);
      const firstInfo = {
        id: 'msg_user_01',
        sessionID: sessionId,
        role: 'user',
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const secondInfo = {
        id: 'msg_assistant_02',
        sessionID: sessionId,
        role: 'assistant',
        time: { created: 200, completed: 250 },
        parentID: firstInfo.id,
        modelID: 'model',
        providerID: 'provider',
        mode: 'build',
        agent: 'build',
        path: { cwd: '/workspace', root: '/workspace' },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      };
      const firstPart = {
        id: 'prt_user_01',
        sessionID: sessionId,
        messageID: firstInfo.id,
        type: 'text',
        text: 'hello',
      };
      const secondPart = {
        id: 'prt_assistant_02',
        sessionID: sessionId,
        messageID: secondInfo.id,
        type: 'text',
        text: 'hello back',
      };

      await stub.ingest(
        [
          { type: 'message', data: firstInfo },
          { type: 'part', data: firstPart },
          { type: 'message', data: secondInfo },
          { type: 'part', data: secondPart },
        ],
        kiloUserId,
        sessionId,
        1
      );

      expect(await stub.readKiloSdkMessages({})).toEqual({
        messages: [
          { info: firstInfo, parts: [firstPart] },
          { info: secondInfo, parts: [secondPart] },
        ],
        nextCursor: null,
        omittedItemCount: 0,
      });
    });

    it('returns invalid_data instead of throwing for malformed persisted transcript identity data', async () => {
      const sessionId = 'ses_sdk_message_invalid_000001';
      const stub = getStub(kiloUserId, sessionId);
      await stub.ingest(
        [
          {
            type: 'message',
            data: { id: 'msg_invalid', sessionID: sessionId, role: 'user', time: { created: -1 } },
          },
        ],
        kiloUserId,
        sessionId,
        1
      );

      expect(await stub.readKiloSdkMessages({ limit: 1 })).toEqual({ kind: 'invalid_data' });
    });

    it('returns invalid_data for a persisted slash-bearing message identity', async () => {
      const sessionId = 'ses_sdk_message_slash_00000001';
      const stub = getStub(kiloUserId, sessionId);
      const storedIdentity = 'msg_parent';
      const persistedInfo = {
        id: 'msg_parent/child',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const r2Key = `items/${sessionId}/message/slash-bearing`;
      await env.SESSION_INGEST_R2.put(r2Key, JSON.stringify(persistedInfo));
      await stub.ingest(
        [
          {
            type: 'message',
            data: { ...persistedInfo, id: storedIdentity },
          },
        ],
        kiloUserId,
        sessionId,
        1,
        1000,
        { [`message/${storedIdentity}`]: r2Key }
      );

      expect(await stub.readKiloSdkMessages({ limit: 1 })).toEqual({ kind: 'invalid_data' });
    });

    it('returns invalid_data before advancing past an oversized historical message storage key', async () => {
      const sessionId = 'ses_sdk_message_historical_key_001';
      const stub = getStub(kiloUserId, sessionId);
      const deferredInfo = {
        id: 'msg_100_deferred',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const deferredKey = `items/${sessionId}/message/deferred`;
      await env.SESSION_INGEST_R2.put(
        deferredKey,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES)
      );
      await stub.ingest([{ type: 'message', data: deferredInfo }], kiloUserId, sessionId, 1, 1000, {
        [`message/${deferredInfo.id}`]: deferredKey,
      });
      const malformedKey = `items/${sessionId}/message/historical-malformed`;
      await env.SESSION_INGEST_R2.put(
        malformedKey,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES + 1)
      );
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data, item_data_r2_key) VALUES (?, ?, ?, ?)',
          'message/msg_parent/child',
          'message',
          '{}',
          malformedKey
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'invalid_data',
      });
    });

    it('returns invalid_data instead of omitting a historical NUL-bearing message storage key', async () => {
      const sessionId = 'ses_sdk_message_nul_key_0000001';
      const stub = getStub(kiloUserId, sessionId);
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          'message/msg_parent\u0000child',
          'message',
          JSON.stringify({
            id: 'msg_parent\u0000child',
            sessionID: sessionId,
            role: 'user',
            time: { created: 100 },
            agent: 'build',
            model: { providerID: 'provider', modelID: 'model' },
          })
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'invalid_data',
      });
    });

    it('returns invalid_data when persisted message storage and body identities disagree', async () => {
      const sessionId = 'ses_sdk_message_identity_mismatch_01';
      const stub = getStub(kiloUserId, sessionId);
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          'message/msg_storage',
          'message',
          JSON.stringify({
            id: 'msg_body',
            sessionID: sessionId,
            role: 'user',
            time: { created: 100 },
            agent: 'build',
            model: { providerID: 'provider', modelID: 'model' },
          })
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'invalid_data',
      });
      await expect(stub.readKiloSdkMessages({})).resolves.toEqual({ kind: 'invalid_data' });
    });

    it('returns a retryable failure instead of an empty missing R2-backed message', async () => {
      const sessionId = 'ses_sdk_message_missing_000001';
      const stub = getStub(kiloUserId, sessionId);
      await stub.ingest(
        [
          {
            type: 'message',
            data: { id: 'msg_missing', sessionID: sessionId, role: 'user', time: { created: 100 } },
          },
        ],
        kiloUserId,
        sessionId,
        1,
        1000,
        { 'message/msg_missing': `items/${sessionId}/message/missing` }
      );

      expect(await stub.readKiloSdkMessages({})).toEqual({
        kind: 'retryable_failure',
        phase: 'message_scan',
      });
    });

    it('returns a retryable failure instead of an empty missing R2-backed selected part', async () => {
      const sessionId = 'ses_sdk_part_missing_00000001';
      const stub = getStub(kiloUserId, sessionId);
      await stub.ingest(
        [
          {
            type: 'message',
            data: { id: 'msg_user_01', sessionID: sessionId, role: 'user', time: { created: 100 } },
          },
          {
            type: 'part',
            data: {
              id: 'prt_user_01',
              sessionID: sessionId,
              messageID: 'msg_user_01',
              type: 'text',
            },
          },
        ],
        kiloUserId,
        sessionId,
        1,
        1000,
        { 'msg_user_01/prt_user_01': `items/${sessionId}/part/missing` }
      );

      expect(await stub.readKiloSdkMessages({ limit: 1 })).toEqual({
        kind: 'retryable_failure',
        phase: 'page_parts',
      });
    });

    it('returns bounded pages by sortable message item_id while preserving native id/time cursors', async () => {
      const sessionId = 'ses_sdk_page_000000000000001';
      const stub = getStub(kiloUserId, sessionId);
      const messages = [
        { id: 'msg_400', created: 100 },
        { id: 'msg_300', created: 400 },
        { id: 'msg_100', created: 300 },
        { id: 'msg_200', created: 200 },
      ].map(message => ({
        id: message.id,
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: message.created },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      }));

      await stub.ingest(
        messages.map(info => ({ type: 'message' as const, data: info })),
        kiloUserId,
        sessionId,
        1
      );

      const latest = await stub.readKiloSdkMessages({ limit: 2 });
      expect(latest.messages.map(message => message.info.id)).toEqual(['msg_300', 'msg_400']);
      expect(latest.nextCursor).toBeTruthy();
      if (!latest.nextCursor) throw new Error('Expected cursor for an older message page');
      expect(JSON.parse(atob(latest.nextCursor.replace(/-/g, '+').replace(/_/g, '/')))).toEqual({
        id: 'msg_300',
        time: 400,
      });

      const earlier = await stub.readKiloSdkMessages({ limit: 2, before: latest.nextCursor });
      expect(earlier.messages.map(message => message.info.id)).toEqual(['msg_100', 'msg_200']);
      expect(earlier.nextCursor).toBeNull();
    });

    it('clamps oversized direct DO page requests to the shared positive page maximum', async () => {
      const sessionId = 'ses_sdk_page_clamped_000000001';
      const stub = getStub(kiloUserId, sessionId);
      const messages = Array.from(
        { length: MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE + 1 },
        (_, index) => ({
          id: `msg_clamped_${String(index).padStart(3, '0')}`,
          sessionID: sessionId,
          role: 'user' as const,
          time: { created: index },
          agent: 'build',
          model: { providerID: 'provider', modelID: 'model' },
        })
      );
      await stub.ingest(
        messages.map(data => ({ type: 'message' as const, data })),
        kiloUserId,
        sessionId,
        1
      );

      const latest = await stub.readKiloSdkMessages({
        limit: MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE + 1,
      });
      expect(latest.messages).toHaveLength(MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE);
      expect(latest.messages[0].info.id).toBe('msg_clamped_001');
      expect(latest.messages[MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE - 1].info.id).toBe(
        'msg_clamped_100'
      );
      expect(latest.nextCursor).toBeTruthy();
    });

    it('does not hydrate an older R2-backed message outside a bounded newest page', async () => {
      const sessionId = 'ses_sdk_page_r2_skip_000000001';
      const stub = getStub(kiloUserId, sessionId);
      const message = (id: string, created: number) => ({
        id,
        sessionID: sessionId,
        role: 'user' as const,
        time: { created },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      });

      await stub.ingest(
        [{ type: 'message', data: message('msg_100_old_r2', 100) }],
        kiloUserId,
        sessionId,
        1,
        1000,
        { 'message/msg_100_old_r2': `items/${sessionId}/missing-old-message` }
      );
      await stub.ingest(
        [
          { type: 'message', data: message('msg_200_new_1', 200) },
          { type: 'message', data: message('msg_300_new_2', 300) },
        ],
        kiloUserId,
        sessionId,
        1
      );

      const latest = await stub.readKiloSdkMessages({ limit: 2 });
      expect(latest.messages.map(entry => entry.info.id)).toEqual([
        'msg_200_new_1',
        'msg_300_new_2',
      ]);
      expect(latest.nextCursor).toBeTruthy();
      if (!latest.nextCursor) throw new Error('Expected cursor for an older message page');
      await expect(
        stub.readKiloSdkMessages({ limit: 2, before: latest.nextCursor })
      ).resolves.toEqual({
        kind: 'retryable_failure',
        phase: 'message_scan',
      });
    });

    it('preserves unbounded cold-read materialization behavior', async () => {
      const sessionId = 'ses_sdk_page_unbounded_000000001';
      const stub = getStub(kiloUserId, sessionId);
      const messages = [
        { id: 'msg_later', created: 200 },
        { id: 'msg_earlier', created: 100 },
      ].map(message => ({
        id: message.id,
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: message.created },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      }));
      await stub.ingest(
        messages.map(data => ({ type: 'message' as const, data })),
        kiloUserId,
        sessionId,
        1
      );

      const omittedLimit = await stub.readKiloSdkMessages({});
      expect(omittedLimit.messages.map(entry => entry.info.id)).toEqual([
        'msg_earlier',
        'msg_later',
      ]);
      const zeroLimit = await stub.readKiloSdkMessages({ limit: 0 });
      expect(zeroLimit.messages.map(entry => entry.info.id)).toEqual(['msg_earlier', 'msg_later']);
    });

    it('hydrates selected R2-backed messages while skipping older R2 bodies', async () => {
      const sessionId = 'ses_sdk_page_selected_r2_000001';
      const stub = getStub(kiloUserId, sessionId);
      const message = (id: string, created: number) => ({
        id,
        sessionID: sessionId,
        role: 'user' as const,
        time: { created },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      });
      const selected = message('msg_200_selected_r2', 200);
      const selectedKey = `items/${sessionId}/selected-r2-message`;
      await env.SESSION_INGEST_R2.put(selectedKey, JSON.stringify(selected));
      await stub.ingest(
        [{ type: 'message', data: message('msg_100_old_r2', 100) }],
        kiloUserId,
        sessionId,
        1,
        1000,
        { 'message/msg_100_old_r2': `items/${sessionId}/missing-old-message` }
      );
      await stub.ingest([{ type: 'message', data: selected }], kiloUserId, sessionId, 1, 1001, {
        'message/msg_200_selected_r2': selectedKey,
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toMatchObject({
        messages: [{ info: selected }],
        nextCursor: expect.any(String),
      });
    });

    it('applies a bounded page before hydrating aggregate inline history', async () => {
      const sessionId = 'ses_sdk_page_large_history_000001';
      const stub = getStub(kiloUserId, sessionId);
      for (let index = 0; index < 9; index++) {
        await stub.ingest(
          [
            {
              type: 'message',
              data: {
                id: `msg_large_${index}`,
                sessionID: sessionId,
                role: 'user',
                time: { created: index },
                agent: 'build',
                model: { providerID: 'provider', modelID: 'model' },
                system: 'x'.repeat(1024 * 1024),
              },
            },
          ],
          kiloUserId,
          sessionId,
          1
        );
      }

      const latest = await stub.readKiloSdkMessages({ limit: 2 });
      expect(latest.messages.map(entry => entry.info.id)).toEqual(['msg_large_7', 'msg_large_8']);
      expect(latest.nextCursor).toBeTruthy();
    });

    it('skips an intrinsically oversized newest message and continues scanning older bounded candidates', async () => {
      const sessionId = 'ses_sdk_page_skip_large_msg_0001';
      const stub = getStub(kiloUserId, sessionId);
      const message = (id: string, created: number) => ({
        id,
        sessionID: sessionId,
        role: 'user' as const,
        time: { created },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      });
      const oversized = { ...message('msg_300_oversized', 300), system: 'x'.repeat(1024) };
      const oversizedParts = ['prt_oversized_01', 'prt_oversized_02'].map(id => ({
        id,
        sessionID: sessionId,
        messageID: oversized.id,
        type: 'text' as const,
        text: 'persisted but permanently unreachable',
      }));
      const oversizedKey = `items/${sessionId}/oversized-message`;
      await env.SESSION_INGEST_R2.put(oversizedKey, JSON.stringify(oversized));
      await stub.ingest(
        [
          { type: 'message', data: message('msg_100_old', 100) },
          { type: 'message', data: message('msg_200_readable', 200) },
        ],
        kiloUserId,
        sessionId,
        1
      );
      await stub.ingest(
        [
          { type: 'message', data: oversized },
          ...oversizedParts.map(data => ({ type: 'part' as const, data })),
        ],
        kiloUserId,
        sessionId,
        1,
        1000,
        { 'message/msg_300_oversized': oversizedKey }
      );

      await env.SESSION_INGEST_R2.put(
        oversizedKey,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES + 1)
      );

      const latest = await stub.readKiloSdkMessages({ limit: 1 });
      expect(latest.messages.map(entry => entry.info.id)).toEqual(['msg_200_readable']);
      expect(latest.omittedItemCount).toBe(3);
      expect(latest.nextCursor).toBeTruthy();
      if (!latest.nextCursor) throw new Error('Expected cursor for the remaining older page');
      await expect(
        stub.readKiloSdkMessages({ limit: 1, before: latest.nextCursor })
      ).resolves.toMatchObject({
        messages: [{ info: { id: 'msg_100_old' } }],
        nextCursor: null,
        omittedItemCount: 0,
      });
      await expect(stub.readKiloSdkMessages({})).resolves.toEqual({
        kind: 'too_large',
        maximumBytes: MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES,
        phase: 'message_scan',
      });
    });

    it('counts direct parts for an omitted oversized astral Unicode message identity', async () => {
      const sessionId = 'ses_sdk_page_astral_omit_00000001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_😀',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const part = {
        id: 'prt_astral',
        sessionID: sessionId,
        messageID: info.id,
        type: 'text' as const,
        text: 'persisted direct child',
      };
      const oversizedKey = `items/${sessionId}/astral-oversized-message`;
      await env.SESSION_INGEST_R2.put(
        oversizedKey,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES + 1)
      );
      await stub.ingest(
        [
          { type: 'message', data: info },
          { type: 'part', data: part },
        ],
        kiloUserId,
        sessionId,
        1,
        1000,
        { [`message/${info.id}`]: oversizedKey }
      );

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        messages: [],
        nextCursor: null,
        omittedItemCount: 2,
      });
    });

    it('counts a NUL-free control-byte part with unaligned zero hex digits when omitting an oversized message', async () => {
      const sessionId = 'ses_sdk_page_unaligned_hex_omit_001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_parent',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const part = {
        id: 'prt_\u0010\u0001',
        sessionID: sessionId,
        messageID: info.id,
        type: 'text' as const,
        text: 'valid NUL-free control-byte identity',
      };
      const oversizedKey = `items/${sessionId}/control-byte-oversized-message`;
      await env.SESSION_INGEST_R2.put(
        oversizedKey,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES + 1)
      );
      await stub.ingest(
        [
          { type: 'message', data: info },
          { type: 'part', data: part },
        ],
        kiloUserId,
        sessionId,
        1,
        1000,
        { [`message/${info.id}`]: oversizedKey }
      );

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        messages: [],
        nextCursor: null,
        omittedItemCount: 2,
      });
    });

    it('returns invalid_data when an oversized message omission count encounters an ambiguous historical part key', async () => {
      const sessionId = 'ses_sdk_page_ambiguous_omit_0001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_parent',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const oversizedKey = `items/${sessionId}/ambiguous-oversized-message`;
      await env.SESSION_INGEST_R2.put(
        oversizedKey,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES + 1)
      );
      await stub.ingest([{ type: 'message', data: info }], kiloUserId, sessionId, 1, 1000, {
        [`message/${info.id}`]: oversizedKey,
      });
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          'msg_parent/child/prt_1',
          'part',
          JSON.stringify({ id: 'prt_1', messageID: 'msg_parent/child', type: 'text' })
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'invalid_data',
      });
    });

    it('returns invalid_data when an oversized message omission count encounters a malformed direct historical part key', async () => {
      const sessionId = 'ses_sdk_page_malformed_omit_0001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_parent',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const oversizedKey = `items/${sessionId}/malformed-direct-oversized-message`;
      await env.SESSION_INGEST_R2.put(
        oversizedKey,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES + 1)
      );
      await stub.ingest([{ type: 'message', data: info }], kiloUserId, sessionId, 1, 1000, {
        [`message/${info.id}`]: oversizedKey,
      });
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          'msg_parent/not-a-part-id',
          'part',
          JSON.stringify({ id: 'not-a-part-id', messageID: info.id, type: 'text' })
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'invalid_data',
      });
    });

    it('returns invalid_data when an oversized message omission count encounters a historical NUL-bearing part key', async () => {
      const sessionId = 'ses_sdk_page_nul_omit_00000001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_parent',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const oversizedKey = `items/${sessionId}/nul-direct-oversized-message`;
      await env.SESSION_INGEST_R2.put(
        oversizedKey,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES + 1)
      );
      await stub.ingest([{ type: 'message', data: info }], kiloUserId, sessionId, 1, 1000, {
        [`message/${info.id}`]: oversizedKey,
      });
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          'msg_parent/prt_storage\u0000child',
          'part',
          JSON.stringify({ id: 'prt_storage\u0000child', messageID: info.id, type: 'text' })
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'invalid_data',
      });
    });

    it('does not count a case-distinct sibling part when omitting an oversized message', async () => {
      const sessionId = 'ses_sdk_page_case_omit_000000001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_parent',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const oversizedKey = `items/${sessionId}/mixed-case-oversized-message`;
      await env.SESSION_INGEST_R2.put(
        oversizedKey,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES + 1)
      );
      await stub.ingest([{ type: 'message', data: info }], kiloUserId, sessionId, 1, 1000, {
        [`message/${info.id}`]: oversizedKey,
      });
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          'msg_Parent/prt_sibling',
          'part',
          JSON.stringify({ id: 'prt_sibling', messageID: 'msg_Parent', type: 'text' })
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        messages: [],
        nextCursor: null,
        omittedItemCount: 1,
      });
    });

    it('hydrates parts only for their case-distinct message identity', async () => {
      const sessionId = 'ses_sdk_page_case_hydrate_0000001';
      const stub = getStub(kiloUserId, sessionId);
      const messages = ['msg_parent', 'msg_Parent'].map((id, index) => ({
        id,
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: index },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      }));
      const parts = messages.map(info => ({
        id: info.id === 'msg_parent' ? 'prt_lower' : 'prt_upper',
        sessionID: sessionId,
        messageID: info.id,
        type: 'text' as const,
        text: `part for ${info.id}`,
      }));
      await stub.ingest(
        [
          ...messages.map(data => ({ type: 'message' as const, data })),
          ...parts.map(data => ({ type: 'part' as const, data })),
        ],
        kiloUserId,
        sessionId,
        1
      );

      const page = await stub.readKiloSdkMessages({ limit: 2 });
      expect(page.omittedItemCount).toBe(0);
      expect(page.messages).toHaveLength(2);
      expect(page.messages.find(message => message.info.id === 'msg_parent')?.parts).toEqual([
        parts[0],
      ]);
      expect(page.messages.find(message => message.info.id === 'msg_Parent')?.parts).toEqual([
        parts[1],
      ]);
    });

    it('hydrates a direct part for an astral Unicode message identity', async () => {
      const sessionId = 'ses_sdk_page_astral_hydrate_000001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_😀',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const part = {
        id: 'prt_astral',
        sessionID: sessionId,
        messageID: info.id,
        type: 'text' as const,
        text: 'hydrated direct child',
      };
      await stub.ingest(
        [
          { type: 'message', data: info },
          { type: 'part', data: part },
        ],
        kiloUserId,
        sessionId,
        1
      );

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        messages: [{ info, parts: [part] }],
        nextCursor: null,
        omittedItemCount: 0,
      });
    });

    it('hydrates a NUL-free control-byte part whose hex contains unaligned zero digits', async () => {
      const sessionId = 'ses_sdk_page_unaligned_hex_hydrate_01';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_parent',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const part = {
        id: 'prt_\u0010\u0001',
        sessionID: sessionId,
        messageID: info.id,
        type: 'text' as const,
        text: 'valid NUL-free control-byte identity',
      };
      await stub.ingest(
        [
          { type: 'message', data: info },
          { type: 'part', data: part },
        ],
        kiloUserId,
        sessionId,
        1
      );

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        messages: [{ info, parts: [part] }],
        nextCursor: null,
        omittedItemCount: 0,
      });
    });

    it('returns invalid_data when selected message hydration encounters an ambiguous historical part key', async () => {
      const sessionId = 'ses_sdk_page_ambiguous_part_0001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_parent',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      await stub.ingest([{ type: 'message', data: info }], kiloUserId, sessionId, 1);
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          'msg_parent/child/prt_1',
          'part',
          JSON.stringify({ id: 'prt_1', messageID: 'msg_parent/child', type: 'text' })
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'invalid_data',
      });
    });

    it('returns invalid_data when persisted part storage and body part identities disagree', async () => {
      const sessionId = 'ses_sdk_page_part_id_mismatch_001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_parent',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      await stub.ingest([{ type: 'message', data: info }], kiloUserId, sessionId, 1);
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          'msg_parent/prt_storage',
          'part',
          JSON.stringify({
            id: 'prt_other',
            sessionID: sessionId,
            messageID: info.id,
            type: 'text',
            text: 'contradictory identity',
          })
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'invalid_data',
      });
    });

    it('returns invalid_data when persisted part storage and body message identities disagree', async () => {
      const sessionId = 'ses_sdk_page_part_msg_mismatch_01';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_parent',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      await stub.ingest([{ type: 'message', data: info }], kiloUserId, sessionId, 1);
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          'msg_parent/prt_storage',
          'part',
          JSON.stringify({
            id: 'prt_storage',
            sessionID: sessionId,
            messageID: 'msg_other',
            type: 'text',
            text: 'contradictory identity',
          })
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'invalid_data',
      });
    });

    it('returns invalid_data for a persisted slash-bearing part body identity', async () => {
      const sessionId = 'ses_sdk_page_part_slash_body_001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_parent',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      await stub.ingest([{ type: 'message', data: info }], kiloUserId, sessionId, 1);
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          'msg_parent/prt_storage',
          'part',
          JSON.stringify({
            id: 'prt_storage/child',
            sessionID: sessionId,
            messageID: info.id,
            type: 'text',
            text: 'historical identity',
          })
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'invalid_data',
      });
    });

    it('returns invalid_data for a selected historical NUL-bearing part storage key', async () => {
      const sessionId = 'ses_sdk_page_part_nul_key_000001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_parent',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      await stub.ingest([{ type: 'message', data: info }], kiloUserId, sessionId, 1);
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          'msg_parent/prt_storage\u0000child',
          'part',
          JSON.stringify({
            id: 'prt_storage\u0000child',
            sessionID: sessionId,
            messageID: info.id,
            type: 'text',
            text: 'historical identity',
          })
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'invalid_data',
      });
    });

    it('ignores a dangling historical NUL-bearing part storage key outside the selected message prefix', async () => {
      const sessionId = 'ses_sdk_page_part_nul_dangling_001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_parent',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      await stub.ingest([{ type: 'message', data: info }], kiloUserId, sessionId, 1);
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          'msg_parent\u0000shadow/prt_1',
          'part',
          JSON.stringify({ id: 'prt_1', messageID: info.id, type: 'text' })
        );
      });

      const expected = {
        messages: [{ info, parts: [] }],
        nextCursor: null,
        omittedItemCount: 0,
      };
      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual(expected);
      await expect(stub.readKiloSdkMessages({})).resolves.toEqual(expected);
    });

    it('returns invalid_data for a selected historical NUL-bearing part body identity', async () => {
      const sessionId = 'ses_sdk_page_part_nul_body_00001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_parent',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      await stub.ingest([{ type: 'message', data: info }], kiloUserId, sessionId, 1);
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          'msg_parent/prt_storage',
          'part',
          JSON.stringify({
            id: 'prt_storage\u0000child',
            sessionID: sessionId,
            messageID: info.id,
            type: 'text',
            text: 'historical identity',
          })
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'invalid_data',
      });
    });

    it('skips an intrinsically oversized part without blocking its bounded message page', async () => {
      const sessionId = 'ses_sdk_page_skip_large_part_001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_100_readable',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const oversizedPart = {
        id: 'prt_200_oversized',
        sessionID: sessionId,
        messageID: info.id,
        type: 'text' as const,
        text: 'x'.repeat(1024),
      };
      const readablePart = {
        id: 'prt_100_readable',
        sessionID: sessionId,
        messageID: info.id,
        type: 'text' as const,
        text: 'retained',
      };
      const oversizedKey = `items/${sessionId}/oversized-part`;
      await env.SESSION_INGEST_R2.put(oversizedKey, JSON.stringify(oversizedPart));
      await stub.ingest(
        [
          { type: 'message', data: info },
          { type: 'part', data: readablePart },
        ],
        kiloUserId,
        sessionId,
        1
      );
      await stub.ingest([{ type: 'part', data: oversizedPart }], kiloUserId, sessionId, 1, 1000, {
        [`${info.id}/${oversizedPart.id}`]: oversizedKey,
      });

      await env.SESSION_INGEST_R2.put(
        oversizedKey,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES + 1)
      );

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        messages: [{ info, parts: [readablePart] }],
        nextCursor: null,
        omittedItemCount: 1,
      });
      await expect(stub.readKiloSdkMessages({ limit: 0 })).resolves.toEqual({
        kind: 'too_large',
        maximumBytes: MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES,
        phase: 'page_parts',
      });
    });

    it('returns invalid_data for a malformed R2-backed selected part', async () => {
      const sessionId = 'ses_sdk_page_invalid_r2_part_001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_100_invalid_part',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const part = {
        id: 'prt_100_invalid_json',
        sessionID: sessionId,
        messageID: info.id,
        type: 'text' as const,
        text: 'not-used',
      };
      const key = `items/${sessionId}/invalid-json-part`;
      await env.SESSION_INGEST_R2.put(key, 'not-json');
      await stub.ingest(
        [
          { type: 'message', data: info },
          { type: 'part', data: part },
        ],
        kiloUserId,
        sessionId,
        1,
        1000,
        { [`${info.id}/${part.id}`]: key }
      );

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'invalid_data',
      });
    });

    it('counts remaining parts for an astral Unicode identity after aggregate hydration stops', async () => {
      const sessionId = 'ses_sdk_page_part_budget_00001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_😀',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const parts = [
        'prt_100_first',
        'prt_200_second',
        'prt_300_third',
        'prt_400_fourth',
        'prt_500_fifth',
        'prt_600_sixth',
      ].map(id => ({
        id,
        sessionID: sessionId,
        messageID: info.id,
        type: 'text' as const,
        text: 'x'.repeat(1536 * 1024),
      }));
      await stub.ingest(
        [{ type: 'message', data: info }, ...parts.map(data => ({ type: 'part' as const, data }))],
        kiloUserId,
        sessionId,
        1
      );

      const page = await stub.readKiloSdkMessages({ limit: 1 });
      expect(page.messages).toHaveLength(1);
      expect(page.messages[0].info).toEqual(info);
      expect(page.messages[0].parts.map(part => part.id)).toEqual([
        'prt_100_first',
        'prt_200_second',
        'prt_300_third',
        'prt_400_fourth',
        'prt_500_fifth',
      ]);
      expect(page.omittedItemCount).toBe(1);
      expect(page.nextCursor).toBeNull();
      await expect(stub.readKiloSdkMessages({ limit: 0 })).resolves.toEqual({
        kind: 'too_large',
        maximumBytes: MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES,
        phase: 'page_parts',
      });
    });

    it('keeps selected message shells after aggregate part hydration stops', async () => {
      const sessionId = 'ses_sdk_page_multi_part_budget_001';
      const stub = getStub(kiloUserId, sessionId);
      const message = (id: string, created: number) => ({
        id,
        sessionID: sessionId,
        role: 'user' as const,
        time: { created },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      });
      const older = message('msg_100_older_parts', 100);
      const newest = message('msg_200_newest_parts', 200);
      const newestParts = [
        'prt_200_first',
        'prt_300_second',
        'prt_400_third',
        'prt_500_fourth',
        'prt_600_fifth',
        'prt_700_sixth',
      ].map(id => ({
        id,
        sessionID: sessionId,
        messageID: newest.id,
        type: 'text' as const,
        text: 'x'.repeat(1536 * 1024),
      }));
      const olderParts = ['prt_100_older_first', 'prt_110_older_second'].map(id => ({
        id,
        sessionID: sessionId,
        messageID: older.id,
        type: 'text' as const,
        text: 'older omitted sibling',
      }));
      await stub.ingest(
        [
          { type: 'message', data: older },
          ...olderParts.map(data => ({ type: 'part' as const, data })),
          { type: 'message', data: newest },
          ...newestParts.map(data => ({ type: 'part' as const, data })),
        ],
        kiloUserId,
        sessionId,
        1
      );

      const page = await stub.readKiloSdkMessages({ limit: 2 });
      expect(page.messages.map(message => message.info.id)).toEqual([older.id, newest.id]);
      expect(page.messages[0].parts).toEqual([]);
      expect(page.messages[1].parts.map(part => part.id)).toEqual([
        'prt_200_first',
        'prt_300_second',
        'prt_400_third',
        'prt_500_fourth',
        'prt_600_fifth',
      ]);
      expect(page.omittedItemCount).toBe(3);
      expect(page.nextCursor).toBeNull();
    });

    it('returns invalid_data when aggregate-stop remaining-part counting encounters a malformed direct historical part key', async () => {
      const sessionId = 'ses_sdk_page_stop_malformed_0001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_100_parts',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const parts = [
        'prt_100_first',
        'prt_200_second',
        'prt_300_third',
        'prt_400_fourth',
        'prt_500_fifth',
        'prt_600_sixth',
      ].map(id => ({
        id,
        sessionID: sessionId,
        messageID: info.id,
        type: 'text' as const,
        text: 'x'.repeat(1536 * 1024),
      }));
      await stub.ingest(
        [{ type: 'message', data: info }, ...parts.map(data => ({ type: 'part' as const, data }))],
        kiloUserId,
        sessionId,
        1
      );
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          `${info.id}/not-a-part-id`,
          'part',
          JSON.stringify({ id: 'not-a-part-id', messageID: info.id, type: 'text' })
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'invalid_data',
      });
    });

    it('does not count a case-distinct sibling part after aggregate hydration stops', async () => {
      const sessionId = 'ses_sdk_page_stop_case_00000001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_100_parts',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const parts = [
        'prt_100_first',
        'prt_200_second',
        'prt_300_third',
        'prt_400_fourth',
        'prt_500_fifth',
        'prt_600_sixth',
      ].map(id => ({
        id,
        sessionID: sessionId,
        messageID: info.id,
        type: 'text' as const,
        text: 'x'.repeat(1536 * 1024),
      }));
      await stub.ingest(
        [{ type: 'message', data: info }, ...parts.map(data => ({ type: 'part' as const, data }))],
        kiloUserId,
        sessionId,
        1
      );
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          'MSG_100_parts/prt_historical',
          'part',
          JSON.stringify({ id: 'prt_historical', messageID: 'MSG_100_parts', type: 'text' })
        );
      });

      const page = await stub.readKiloSdkMessages({ limit: 1 });
      expect(page.messages).toHaveLength(1);
      expect(page.messages[0].info).toEqual(info);
      expect(page.messages[0].parts.map(part => part.id)).toEqual([
        'prt_100_first',
        'prt_200_second',
        'prt_300_third',
        'prt_400_fourth',
        'prt_500_fifth',
      ]);
      expect(page.omittedItemCount).toBe(1);
      expect(page.nextCursor).toBeNull();
    });

    it('returns invalid_data when later-shell part counting encounters a malformed direct historical part key', async () => {
      const sessionId = 'ses_sdk_page_shell_malformed_001';
      const stub = getStub(kiloUserId, sessionId);
      const message = (id: string, created: number) => ({
        id,
        sessionID: sessionId,
        role: 'user' as const,
        time: { created },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      });
      const older = message('msg_100_older_parts', 100);
      const newest = message('msg_200_newest_parts', 200);
      const newestParts = [
        'prt_200_first',
        'prt_300_second',
        'prt_400_third',
        'prt_500_fourth',
        'prt_600_fifth',
        'prt_700_sixth',
      ].map(id => ({
        id,
        sessionID: sessionId,
        messageID: newest.id,
        type: 'text' as const,
        text: 'x'.repeat(1536 * 1024),
      }));
      await stub.ingest(
        [
          { type: 'message', data: older },
          { type: 'message', data: newest },
          ...newestParts.map(data => ({ type: 'part' as const, data })),
        ],
        kiloUserId,
        sessionId,
        1
      );
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'INSERT INTO ingest_items (item_id, item_type, item_data) VALUES (?, ?, ?)',
          `${older.id}/not-a-part-id`,
          'part',
          JSON.stringify({ id: 'not-a-part-id', messageID: older.id, type: 'text' })
        );
      });

      await expect(stub.readKiloSdkMessages({ limit: 2 })).resolves.toEqual({
        kind: 'invalid_data',
      });
    });

    it('returns a short resumable page when aggregate message-info bytes leave the next candidate unreachable', async () => {
      const sessionId = 'ses_sdk_page_info_budget_00001';
      const stub = getStub(kiloUserId, sessionId);
      const infos = ['msg_100_oldest', 'msg_200_deferred', 'msg_300_selected'].map((id, index) => ({
        id,
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: index },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
        system: 'x'.repeat(4 * 1024 * 1024),
      }));
      const references: Record<string, string> = {};
      for (const info of infos) {
        const key = `items/${sessionId}/${info.id}`;
        references[`message/${info.id}`] = key;
        await env.SESSION_INGEST_R2.put(key, JSON.stringify(info));
      }
      await stub.ingest(
        infos.map(data => ({ type: 'message' as const, data })),
        kiloUserId,
        sessionId,
        1,
        1000,
        references
      );

      const latest = await stub.readKiloSdkMessages({ limit: 2 });
      expect(latest.messages.map(message => message.info.id)).toEqual(['msg_300_selected']);
      expect(latest.omittedItemCount).toBe(0);
      expect(latest.nextCursor).toBeTruthy();
      if (!latest.nextCursor)
        throw new Error('Expected an ordinary cursor for the remaining pages');
      expect(decodeKiloSdkMessagesCursor(latest.nextCursor)).toEqual({
        id: 'msg_300_selected',
        time: 2,
      });

      const earlier = await stub.readKiloSdkMessages({ limit: 1, before: latest.nextCursor });
      expect(earlier.messages.map(message => message.info.id)).toEqual(['msg_200_deferred']);
      expect(earlier.nextCursor).toBeTruthy();
      if (!earlier.nextCursor) throw new Error('Expected an ordinary cursor for the final page');
      expect(decodeKiloSdkMessagesCursor(earlier.nextCursor)).toEqual({
        id: 'msg_200_deferred',
        time: 1,
      });

      const final = await stub.readKiloSdkMessages({ limit: 1, before: earlier.nextCursor });
      expect(final.messages.map(message => message.info.id)).toEqual(['msg_100_oldest']);
      expect(final.nextCursor).toBeNull();
      expect(
        [...latest.messages, ...earlier.messages, ...final.messages].map(message => message.info.id)
      ).toEqual(['msg_300_selected', 'msg_200_deferred', 'msg_100_oldest']);
    });

    it('returns too_large when the first message exceeds the post-overhead aggregate budget', async () => {
      const sessionId = 'ses_sdk_page_first_budget_fail_001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_100_aggregate_budget',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
        system: '',
      };
      const baseByteLength = new TextEncoder().encode(JSON.stringify(info)).byteLength;
      const aggregateOnlyInfo = {
        ...info,
        system: 'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES - baseByteLength),
      };
      const aggregateOnlyData = JSON.stringify(aggregateOnlyInfo);
      expect(new TextEncoder().encode(aggregateOnlyData).byteLength).toBe(
        MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES
      );
      const key = `items/${sessionId}/first-candidate-aggregate-budget-message`;
      await env.SESSION_INGEST_R2.put(key, aggregateOnlyData);
      await stub.ingest([{ type: 'message', data: info }], kiloUserId, sessionId, 1, 1000, {
        [`message/${info.id}`]: key,
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'too_large',
        maximumBytes: MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES,
        phase: 'message_scan',
      });
    });

    it('returns an omitted-only terminal bounded page with an explicit omission count', async () => {
      const sessionId = 'ses_sdk_page_only_oversized_0001';
      const stub = getStub(kiloUserId, sessionId);
      const info = {
        id: 'msg_100_oversized',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 100 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const key = `items/${sessionId}/only-oversized-message`;
      await env.SESSION_INGEST_R2.put(
        key,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES + 1)
      );
      await stub.ingest([{ type: 'message', data: info }], kiloUserId, sessionId, 1, 1000, {
        [`message/${info.id}`]: key,
      });

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        messages: [],
        nextCursor: null,
        omittedItemCount: 1,
      });
    });

    it('continues scanning older batches internally until it finds a readable message', async () => {
      const sessionId = 'ses_sdk_page_scan_older_batch_001';
      const stub = getStub(kiloUserId, sessionId);
      const oversizedInfos = Array.from(
        { length: KILO_SDK_HISTORY_BOUNDED_MESSAGE_SCAN_ROW_WORK_CAP / 2 + 1 },
        (_, index) => ({
          id: `msg_oversized_${String(index).padStart(3, '0')}`,
          sessionID: sessionId,
          role: 'user' as const,
          time: { created: index + 1 },
          agent: 'build',
          model: { providerID: 'provider', modelID: 'model' },
        })
      );
      const readableInfo = {
        id: 'msg_000_readable',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 0 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const references: Record<string, string> = {};
      const oversizedKey = `items/${sessionId}/shared-oversized-message`;
      await env.SESSION_INGEST_R2.put(
        oversizedKey,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES + 1)
      );
      for (const info of oversizedInfos) {
        references[`message/${info.id}`] = oversizedKey;
      }
      await stub.ingest(
        [readableInfo, ...oversizedInfos].map(data => ({ type: 'message' as const, data })),
        kiloUserId,
        sessionId,
        1,
        1000,
        references
      );

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        messages: [{ info: readableInfo, parts: [] }],
        nextCursor: null,
        omittedItemCount: oversizedInfos.length,
      });
    });

    it('returns a terminal empty page when an omitted-only run ends exactly at bounded scan work', async () => {
      const sessionId = 'ses_sdk_page_scan_exact_cap_0001';
      const stub = getStub(kiloUserId, sessionId);
      const infos = Array.from(
        { length: KILO_SDK_HISTORY_BOUNDED_MESSAGE_SCAN_ROW_WORK_CAP },
        (_, index) => ({
          id: `msg_oversized_${String(index).padStart(3, '0')}`,
          sessionID: sessionId,
          role: 'user' as const,
          time: { created: index },
          agent: 'build',
          model: { providerID: 'provider', modelID: 'model' },
        })
      );
      const references: Record<string, string> = {};
      const oversizedKey = `items/${sessionId}/shared-oversized-message`;
      await env.SESSION_INGEST_R2.put(
        oversizedKey,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES + 1)
      );
      for (const info of infos) {
        references[`message/${info.id}`] = oversizedKey;
      }
      await stub.ingest(
        infos.map(data => ({ type: 'message' as const, data })),
        kiloUserId,
        sessionId,
        1,
        1000,
        references
      );

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        messages: [],
        nextCursor: null,
        omittedItemCount: KILO_SDK_HISTORY_BOUNDED_MESSAGE_SCAN_ROW_WORK_CAP,
      });
    });

    it('returns too_large when skipped rows prevent a native cursor from advancing', async () => {
      const sessionId = 'ses_sdk_page_scan_suffix_cap_0001';
      const stub = getStub(kiloUserId, sessionId);
      const newestReadableInfo = {
        id: 'msg_z_readable',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: KILO_SDK_HISTORY_BOUNDED_MESSAGE_SCAN_ROW_WORK_CAP },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const oldestReadableInfo = {
        id: 'msg_000_readable',
        sessionID: sessionId,
        role: 'user' as const,
        time: { created: 0 },
        agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
      };
      const oversizedInfos = Array.from(
        { length: KILO_SDK_HISTORY_BOUNDED_MESSAGE_SCAN_ROW_WORK_CAP - 1 },
        (_, index) => ({
          id: `msg_oversized_${String(index).padStart(3, '0')}`,
          sessionID: sessionId,
          role: 'user' as const,
          time: { created: index + 1 },
          agent: 'build',
          model: { providerID: 'provider', modelID: 'model' },
        })
      );
      const references: Record<string, string> = {};
      const oversizedKey = `items/${sessionId}/shared-oversized-message`;
      await env.SESSION_INGEST_R2.put(
        oversizedKey,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES + 1)
      );
      for (const info of oversizedInfos) {
        references[`message/${info.id}`] = oversizedKey;
      }
      await stub.ingest(
        [oldestReadableInfo, ...oversizedInfos, newestReadableInfo].map(data => ({
          type: 'message' as const,
          data,
        })),
        kiloUserId,
        sessionId,
        1,
        1000,
        references
      );

      await expect(stub.readKiloSdkMessages({ limit: 2 })).resolves.toEqual({
        kind: 'too_large',
        maximumBytes: MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES,
        phase: 'message_scan',
      });
    });

    it('returns too_large when an omitted-only run exceeds bounded scan work', async () => {
      const sessionId = 'ses_sdk_page_scan_cap_00000001';
      const stub = getStub(kiloUserId, sessionId);
      const infos = Array.from(
        { length: KILO_SDK_HISTORY_BOUNDED_MESSAGE_SCAN_ROW_WORK_CAP + 1 },
        (_, index) => ({
          id: `msg_oversized_${String(index).padStart(3, '0')}`,
          sessionID: sessionId,
          role: 'user' as const,
          time: { created: index },
          agent: 'build',
          model: { providerID: 'provider', modelID: 'model' },
        })
      );
      const references: Record<string, string> = {};
      const oversizedKey = `items/${sessionId}/shared-oversized-message`;
      await env.SESSION_INGEST_R2.put(
        oversizedKey,
        'x'.repeat(MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES + 1)
      );
      for (const info of infos) {
        references[`message/${info.id}`] = oversizedKey;
      }
      await stub.ingest(
        infos.map(data => ({ type: 'message' as const, data })),
        kiloUserId,
        sessionId,
        1,
        1000,
        references
      );

      await expect(stub.readKiloSdkMessages({ limit: 1 })).resolves.toEqual({
        kind: 'too_large',
        maximumBytes: MAX_KILO_SDK_HISTORY_MATERIALIZATION_BYTES,
        phase: 'message_scan',
      });
    });
  });

  describe('upsert behavior', () => {
    it('updates existing item on duplicate item_id', async () => {
      const sessionId = 'ses_upsert_dedup_0000000004';
      const stub = getStub(kiloUserId, sessionId);

      await stub.ingest(
        [{ type: 'session', data: { title: 'Original Title' } }],
        kiloUserId,
        sessionId,
        1
      );

      await stub.ingest(
        [{ type: 'session', data: { title: 'Updated Title' } }],
        kiloUserId,
        sessionId,
        1
      );

      const raw = await stub.getAllStream().then(s => new Response(s).text());
      const snapshot = JSON.parse(raw);

      expect(snapshot.info).toEqual({ title: 'Updated Title' });
    });
  });

  describe('metadata extraction', () => {
    it('returns title change', async () => {
      const sessionId = 'ses_meta_title_00000000005';
      const stub = getStub(kiloUserId, sessionId);

      const result = await stub.ingest(
        [{ type: 'session', data: { title: 'My Title' } }],
        kiloUserId,
        sessionId,
        1
      );

      const titleChange = result.changes.find(c => c.name === 'title');
      expect(titleChange).toBeDefined();
      expect(titleChange!.value).toBe('My Title');
    });

    it('returns platform and orgId from kilo_meta', async () => {
      const sessionId = 'ses_meta_platform_000000006';
      const stub = getStub(kiloUserId, sessionId);

      const result = await stub.ingest(
        [
          {
            type: 'kilo_meta',
            data: { platform: 'vscode', orgId: '11111111-1111-1111-1111-111111111111' },
          },
        ],
        kiloUserId,
        sessionId,
        1
      );

      expect(result.changes.find(c => c.name === 'platform')?.value).toBe('vscode');
      expect(result.changes.find(c => c.name === 'orgId')?.value).toBe(
        '11111111-1111-1111-1111-111111111111'
      );
    });
  });

  describe('export produces valid JSON', () => {
    it('returns valid JSON from getAllStream even with no items', async () => {
      const sessionId = 'ses_export_empty_0000000007';
      const stub = getStub(kiloUserId, sessionId);

      const raw = await stub.getAllStream().then(s => new Response(s).text());
      const snapshot = JSON.parse(raw);

      expect(snapshot).toHaveProperty('info');
      expect(snapshot).toHaveProperty('messages');
      expect(Array.isArray(snapshot.messages)).toBe(true);
    });

    it('produces valid JSON with many items', async () => {
      const sessionId = 'ses_export_many_00000000008';
      const stub = getStub(kiloUserId, sessionId);

      const items: Array<{ type: string; data: Record<string, unknown> }> = [
        { type: 'session', data: { title: 'Large Session' } },
      ];

      for (let i = 0; i < 50; i++) {
        items.push({
          type: 'message',
          data: { id: `msg_${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` },
        });
        items.push({
          type: 'part',
          data: {
            id: `part_${i}`,
            messageID: `msg_${i}`,
            type: 'text',
            content: `part content ${i}`,
          },
        });
      }

      await stub.ingest(items as never, kiloUserId, sessionId, 1);

      const raw = await stub.getAllStream().then(s => new Response(s).text());
      const snapshot = JSON.parse(raw);

      expect(snapshot.messages).toHaveLength(50);
      for (let i = 0; i < 50; i++) {
        expect(snapshot.messages[i].info.id).toBe(`msg_${i}`);
        expect(snapshot.messages[i].parts).toHaveLength(1);
      }
    });

    it('exports parts only for their case-distinct message identity', async () => {
      const sessionId = 'ses_export_case_parts_00000001';
      const stub = getStub(kiloUserId, sessionId);
      await stub.ingest(
        [
          { type: 'message', data: { id: 'msg_parent' } },
          { type: 'message', data: { id: 'msg_Parent' } },
          { type: 'part', data: { id: 'prt_lower', messageID: 'msg_parent' } },
          { type: 'part', data: { id: 'prt_upper', messageID: 'msg_Parent' } },
        ],
        kiloUserId,
        sessionId,
        1
      );

      const raw = await stub.getAllStream().then(s => new Response(s).text());
      const snapshot = JSON.parse(raw);

      expect(snapshot.messages).toEqual([
        { info: { id: 'msg_parent' }, parts: [{ id: 'prt_lower', messageID: 'msg_parent' }] },
        { info: { id: 'msg_Parent' }, parts: [{ id: 'prt_upper', messageID: 'msg_Parent' }] },
      ]);
    });
  });

  describe('clear', () => {
    it('clears all data from the DO', async () => {
      const sessionId = 'ses_clear_test_00000000009';
      const stub = getStub(kiloUserId, sessionId);

      await stub.ingest(
        [
          { type: 'session', data: { title: 'To Be Cleared' } },
          { type: 'message', data: { id: 'msg_1', role: 'user', content: 'bye' } },
        ],
        kiloUserId,
        sessionId,
        1
      );

      await stub.clear();

      const raw = await stub.getAllStream().then(s => new Response(s).text());
      const snapshot = JSON.parse(raw);

      expect(snapshot.info).toEqual({});
      expect(snapshot.messages).toEqual([]);
    });
  });

  describe('deleted flag', () => {
    it('clear() then ingest() returns empty changes', async () => {
      const sessionId = 'ses_deleted_ingest_0000010';
      const stub = getStub(kiloUserId, sessionId);

      // Ingest, then clear (sets deleted flag)
      await stub.ingest(
        [{ type: 'session', data: { title: 'Before Delete' } }],
        kiloUserId,
        sessionId,
        1
      );
      await stub.clear();

      // Ingest after clear should be a no-op due to deleted flag
      const result = await stub.ingest(
        [{ type: 'session', data: { title: 'After Delete' } }],
        kiloUserId,
        sessionId,
        1
      );

      expect(result.changes).toEqual([]);
    });

    it('clear() then getAllStream() returns empty snapshot', async () => {
      const sessionId = 'ses_deleted_stream_000011';
      const stub = getStub(kiloUserId, sessionId);

      await stub.ingest(
        [
          { type: 'session', data: { title: 'Will Be Deleted' } },
          { type: 'message', data: { id: 'msg_1', role: 'user', content: 'hi' } },
        ],
        kiloUserId,
        sessionId,
        1
      );
      await stub.clear();

      const raw = await stub.getAllStream().then(s => new Response(s).text());
      const snapshot = JSON.parse(raw);

      expect(snapshot.info).toEqual({});
      expect(snapshot.messages).toEqual([]);
    });
  });

  describe('R2-backed items', () => {
    it('exports R2-backed message with resolved data', async () => {
      const sessionId = 'ses_r2_backed_msg_0000014';
      const stub = getStub(kiloUserId, sessionId);

      // Pre-store item data in R2
      const itemData = JSON.stringify({ id: 'msg_r2', role: 'user', content: 'stored in R2' });
      const r2Key = `items/${kiloUserId}/${sessionId}/message/msg_r2/1000`;
      await env.SESSION_INGEST_R2.put(r2Key, itemData);

      // Ingest with R2 reference — DO stores '{}' locally, points to R2
      await stub.ingest(
        [
          { type: 'session', data: { title: 'R2 Test' } },
          { type: 'message', data: { id: 'msg_r2', role: 'user', content: 'stored in R2' } },
        ],
        kiloUserId,
        sessionId,
        1,
        1000,
        { 'message/msg_r2': r2Key }
      );

      const raw = await stub.getAllStream().then(s => new Response(s).text());
      const snapshot = JSON.parse(raw);

      expect(snapshot.info).toEqual({ title: 'R2 Test' });
      expect(snapshot.messages).toHaveLength(1);
      expect(snapshot.messages[0].info.id).toBe('msg_r2');
      expect(snapshot.messages[0].info.content).toBe('stored in R2');
    });

    it('exports R2-backed session info with resolved data', async () => {
      const sessionId = 'ses_r2_backed_ses_0000015';
      const stub = getStub(kiloUserId, sessionId);

      const itemData = JSON.stringify({ title: 'Big Session Info' });
      const r2Key = `items/${kiloUserId}/${sessionId}/session/2000`;
      await env.SESSION_INGEST_R2.put(r2Key, itemData);

      await stub.ingest(
        [{ type: 'session', data: { title: 'Big Session Info' } }],
        kiloUserId,
        sessionId,
        1,
        2000,
        { session: r2Key }
      );

      const raw = await stub.getAllStream().then(s => new Response(s).text());
      const snapshot = JSON.parse(raw);

      expect(snapshot.info).toEqual({ title: 'Big Session Info' });
    });
  });

  describe('timestamp guard', () => {
    it('stale ingest (older ingestedAt) does not overwrite newer item', async () => {
      const sessionId = 'ses_ts_guard_stale_000012';
      const stub = getStub(kiloUserId, sessionId);

      // Ingest with newer timestamp first
      await stub.ingest(
        [{ type: 'session', data: { title: 'Newer' } }],
        kiloUserId,
        sessionId,
        1,
        2000
      );

      // Ingest with older timestamp — should be skipped
      await stub.ingest(
        [{ type: 'session', data: { title: 'Older' } }],
        kiloUserId,
        sessionId,
        1,
        1000
      );

      const raw = await stub.getAllStream().then(s => new Response(s).text());
      const snapshot = JSON.parse(raw);

      expect(snapshot.info).toEqual({ title: 'Newer' });
    });

    it('newer ingest (higher ingestedAt) overwrites older item', async () => {
      const sessionId = 'ses_ts_guard_newer_000013';
      const stub = getStub(kiloUserId, sessionId);

      // Ingest with older timestamp first
      await stub.ingest(
        [{ type: 'session', data: { title: 'Old' } }],
        kiloUserId,
        sessionId,
        1,
        1000
      );

      // Ingest with newer timestamp — should overwrite
      await stub.ingest(
        [{ type: 'session', data: { title: 'New' } }],
        kiloUserId,
        sessionId,
        1,
        2000
      );

      const raw = await stub.getAllStream().then(s => new Response(s).text());
      const snapshot = JSON.parse(raw);

      expect(snapshot.info).toEqual({ title: 'New' });
    });
  });
});
