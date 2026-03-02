/**
 * Integration tests for the command-queue query module.
 *
 * Uses @cloudflare/vitest-pool-workers to test against real SQLite in DOs.
 * Each test gets isolated storage automatically.
 */

import { env, runInDurableObject, listDurableObjectIds } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { createCommandQueueQueries } from '../../../src/session/queries/command-queue.js';

describe('createCommandQueueQueries', () => {
  beforeEach(async () => {
    const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
    expect(ids).toHaveLength(0);
  });

  describe('enqueue', () => {
    it('inserts a new command and returns the generated ID', async () => {
      const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_cq_1');
      const stub = env.CLOUD_AGENT_SESSION.get(id);

      const result = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const queries = createCommandQueueQueries(db, state.storage.sql);

        const queueId = queries.enqueue('session-1', 'exec-1', '{"prompt":"Hello"}');
        return { queueId };
      });

      expect(result.queueId).toBeGreaterThan(0);
    });

    it('auto-increments IDs for multiple inserts', async () => {
      const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_cq_2');
      const stub = env.CLOUD_AGENT_SESSION.get(id);

      const result = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const queries = createCommandQueueQueries(db, state.storage.sql);

        const id1 = queries.enqueue('session-1', 'exec-1', '{"prompt":"First"}');
        const id2 = queries.enqueue('session-1', 'exec-2', '{"prompt":"Second"}');
        const id3 = queries.enqueue('session-2', 'exec-3', '{"prompt":"Third"}');
        return { id1, id2, id3 };
      });

      expect(result.id2).toBeGreaterThan(result.id1);
      expect(result.id3).toBeGreaterThan(result.id2);
    });
  });

  describe('peekOldest', () => {
    it('returns null for empty queue', async () => {
      const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_cq_3');
      const stub = env.CLOUD_AGENT_SESSION.get(id);

      const result = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const queries = createCommandQueueQueries(db, state.storage.sql);
        return queries.peekOldest('session-1');
      });

      expect(result).toBeNull();
    });

    it('returns the oldest entry for a session (FIFO order)', async () => {
      const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_cq_4');
      const stub = env.CLOUD_AGENT_SESSION.get(id);

      const result = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const queries = createCommandQueueQueries(db, state.storage.sql);

        queries.enqueue('session-1', 'exec-1', '{"order":"first"}');
        queries.enqueue('session-1', 'exec-2', '{"order":"second"}');
        queries.enqueue('session-1', 'exec-3', '{"order":"third"}');

        return queries.peekOldest('session-1');
      });

      expect(result).not.toBeNull();
      expect(result!.execution_id).toBe('exec-1');
      expect(result!.message_json).toBe('{"order":"first"}');
    });

    it('only returns entries for the specified session', async () => {
      const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_cq_5');
      const stub = env.CLOUD_AGENT_SESSION.get(id);

      const result = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const queries = createCommandQueueQueries(db, state.storage.sql);

        queries.enqueue('session-1', 'exec-1', '{"session":"1"}');
        queries.enqueue('session-2', 'exec-2', '{"session":"2"}');

        return {
          r1: queries.peekOldest('session-1'),
          r2: queries.peekOldest('session-2'),
        };
      });

      expect(result.r1!.session_id).toBe('session-1');
      expect(result.r2!.session_id).toBe('session-2');
    });

    it('does not remove the entry (peek semantics)', async () => {
      const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_cq_6');
      const stub = env.CLOUD_AGENT_SESSION.get(id);

      const result = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const queries = createCommandQueueQueries(db, state.storage.sql);

        queries.enqueue('session-1', 'exec-1', '{}');
        queries.peekOldest('session-1');
        queries.peekOldest('session-1');

        return queries.count('session-1');
      });

      expect(result).toBe(1);
    });
  });

  describe('dequeueById', () => {
    it('removes the entry with the specified ID', async () => {
      const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_cq_7');
      const stub = env.CLOUD_AGENT_SESSION.get(id);

      const result = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const queries = createCommandQueueQueries(db, state.storage.sql);

        queries.enqueue('session-1', 'exec-1', '{}');
        const id2 = queries.enqueue('session-1', 'exec-2', '{}');
        queries.enqueue('session-1', 'exec-3', '{}');

        queries.dequeueById(id2);

        return queries.count('session-1');
      });

      expect(result).toBe(2);
    });

    it('correctly dequeues after peek (FIFO pattern)', async () => {
      const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_cq_8');
      const stub = env.CLOUD_AGENT_SESSION.get(id);

      const result = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const queries = createCommandQueueQueries(db, state.storage.sql);

        queries.enqueue('session-1', 'exec-1', '{"first":true}');
        queries.enqueue('session-1', 'exec-2', '{"second":true}');

        const first = queries.peekOldest('session-1');
        if (first) queries.dequeueById(first.id);

        return queries.peekOldest('session-1');
      });

      expect(result).not.toBeNull();
      expect(result!.execution_id).toBe('exec-2');
    });
  });

  describe('count', () => {
    it('returns 0 for empty queue', async () => {
      const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_cq_9');
      const stub = env.CLOUD_AGENT_SESSION.get(id);

      const result = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const queries = createCommandQueueQueries(db, state.storage.sql);
        return queries.count('session-1');
      });

      expect(result).toBe(0);
    });

    it('counts only entries for the specified session', async () => {
      const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_cq_10');
      const stub = env.CLOUD_AGENT_SESSION.get(id);

      const result = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const queries = createCommandQueueQueries(db, state.storage.sql);

        queries.enqueue('session-1', 'exec-1', '{}');
        queries.enqueue('session-1', 'exec-2', '{}');
        queries.enqueue('session-2', 'exec-3', '{}');

        return {
          c1: queries.count('session-1'),
          c2: queries.count('session-2'),
          c3: queries.count('session-3'),
        };
      });

      expect(result.c1).toBe(2);
      expect(result.c2).toBe(1);
      expect(result.c3).toBe(0);
    });
  });

  describe('deleteOlderThan', () => {
    it('deletes entries older than the timestamp across all sessions', async () => {
      const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_cq_11');
      const stub = env.CLOUD_AGENT_SESSION.get(id);

      const result = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const queries = createCommandQueueQueries(db, state.storage.sql);
        const now = Date.now();

        state.storage.sql.exec(
          `INSERT INTO command_queue (session_id, execution_id, message_json, created_at) VALUES (?, ?, ?, ?)`,
          'session-1',
          'exec-old',
          '{}',
          now - 3600000 // 1 hour ago
        );
        state.storage.sql.exec(
          `INSERT INTO command_queue (session_id, execution_id, message_json, created_at) VALUES (?, ?, ?, ?)`,
          'session-2',
          'exec-recent',
          '{}',
          now - 60000 // 1 minute ago
        );

        const cutoff = now - 1800000; // 30 min threshold
        const deleted = queries.deleteOlderThan(cutoff);
        const remaining = queries.count('session-1') + queries.count('session-2');
        return { deleted, remaining };
      });

      expect(result.deleted).toBe(1);
      expect(result.remaining).toBe(1);
    });
  });

  describe('deleteExpired', () => {
    it('deletes expired entries for specific session only', async () => {
      const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_cq_12');
      const stub = env.CLOUD_AGENT_SESSION.get(id);

      const result = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const queries = createCommandQueueQueries(db, state.storage.sql);
        const now = Date.now();
        const twoHoursAgo = now - 2 * 60 * 60 * 1000;

        state.storage.sql.exec(
          `INSERT INTO command_queue (session_id, execution_id, message_json, created_at) VALUES (?, ?, ?, ?)`,
          'session-1',
          'exec-expired',
          '{}',
          twoHoursAgo
        );
        state.storage.sql.exec(
          `INSERT INTO command_queue (session_id, execution_id, message_json, created_at) VALUES (?, ?, ?, ?)`,
          'session-1',
          'exec-fresh',
          '{}',
          now
        );
        state.storage.sql.exec(
          `INSERT INTO command_queue (session_id, execution_id, message_json, created_at) VALUES (?, ?, ?, ?)`,
          'session-2',
          'exec-also-expired',
          '{}',
          twoHoursAgo
        );

        const deleted = queries.deleteExpired('session-1');
        return {
          deleted,
          c1: queries.count('session-1'),
          c2: queries.count('session-2'),
        };
      });

      expect(result.deleted).toBe(1);
      expect(result.c1).toBe(1);
      expect(result.c2).toBe(1);
    });
  });

  describe('FIFO ordering', () => {
    it('maintains FIFO order even when entries have the same timestamp', async () => {
      const id = env.CLOUD_AGENT_SESSION.idFromName('user_1:sess_cq_13');
      const stub = env.CLOUD_AGENT_SESSION.get(id);

      const result = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const queries = createCommandQueueQueries(db, state.storage.sql);

        queries.enqueue('session-1', 'first', '{}');
        queries.enqueue('session-1', 'second', '{}');
        queries.enqueue('session-1', 'third', '{}');

        const order: string[] = [];

        const a = queries.peekOldest('session-1');
        if (a) {
          order.push(a.execution_id);
          queries.dequeueById(a.id);
        }
        const b = queries.peekOldest('session-1');
        if (b) {
          order.push(b.execution_id);
          queries.dequeueById(b.id);
        }
        const c = queries.peekOldest('session-1');
        if (c) {
          order.push(c.execution_id);
          queries.dequeueById(c.id);
        }

        return order;
      });

      expect(result).toEqual(['first', 'second', 'third']);
    });
  });
});
