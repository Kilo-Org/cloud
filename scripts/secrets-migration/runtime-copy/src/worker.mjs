// Temporary runtime copier Worker, cron-only, one per source Worker. The rendered config gives it
// no route, custom domain, workers.dev or preview URL, queue, Workflow or service binding, and this
// module exports no fetch handler and no RPC entrypoint: the only event it handles is `scheduled`.
// Each tick writes exactly one sanitized receipt line (core.mjs `runTick`). The `M65_BATCH` pin
// selects one reviewed batch of the table; its bindings must be exactly that batch's (core
// `preGate`). M65Gate admits one run per namespace with a single-row SQLite insert and keeps only
// the fixed final outcome.

import { DurableObject } from 'cloudflare:workers';
import { TABLE } from './table.mjs';
import { OUTCOMES, PIN_FORMAT, newReceipt, runTick } from './core.mjs';

const batchOf = env =>
  typeof env.M65_BATCH === 'string' && Object.hasOwn(TABLE.batches, env.M65_BATCH)
    ? TABLE.batches[env.M65_BATCH]
    : undefined;

export class M65Gate extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS m65_gate (id INTEGER PRIMARY KEY CHECK (id = 1), run_id TEXT NOT NULL, consumed_at INTEGER NOT NULL, outcome TEXT)'
    );
  }

  // Returns consumed_now exactly once; every later call gets already_consumed and the final outcome.
  consume(runId) {
    if (typeof runId !== 'string' || !PIN_FORMAT.M65_RUN_ID.test(runId))
      return { state: 'refused' };
    const cur = this.ctx.storage.sql.exec(
      'INSERT INTO m65_gate (id, run_id, consumed_at) VALUES (1, ?, ?) ON CONFLICT (id) DO NOTHING',
      runId,
      Date.now()
    );
    cur.toArray();
    if (cur.rowsWritten === 1) return { state: 'consumed_now' };
    const row = this.ctx.storage.sql.exec('SELECT outcome FROM m65_gate WHERE id = 1').toArray()[0];
    return {
      state: 'already_consumed',
      prior: OUTCOMES.includes(row?.outcome) ? row.outcome : null,
    };
  }

  finish(outcome) {
    if (!OUTCOMES.includes(outcome)) return false;
    this.ctx.storage.sql.exec(
      'UPDATE m65_gate SET outcome = ? WHERE id = 1 AND outcome IS NULL',
      outcome
    );
    return true;
  }
}

export default {
  async scheduled(controller, env) {
    controller.noRetry();
    let receipt;
    try {
      receipt = await runTick({
        env,
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        now: () => Date.now(),
        fetchImpl: (u, i) => fetch(u, i),
        batch: batchOf(env),
      });
    } catch {
      receipt = { ...newReceipt(batchOf(env)?.id), outcome: 'stopped', reason: 'internal_error' };
    }
    console.log(JSON.stringify(receipt));
  },
};
