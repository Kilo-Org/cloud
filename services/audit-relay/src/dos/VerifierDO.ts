import { DurableObject } from 'cloudflare:workers';
import { withDORetry } from '@kilocode/worker-utils';
import {
  checkpointSignatureValid,
  newestCheckpointKeyAfter,
  readCheckpointFile,
  readPublicKeys,
  type CheckpointFile,
} from '../checkpoint';
import type { Env } from '../env';
import { pageOperator } from '../page';
import { GENESIS_HASH } from '../relay/chain';
import { errorName } from '../relay/error-name';
import { walkStream, type ChainPosition, type VerifyFailureReason } from '../verify';
import { getRegistryDOStub } from './RegistryDO';

/** `daily`: from the last verified checkpoint. `full`: from the genesis hash of every stream. */
export type VerifyPassKind = 'daily' | 'full';

/**
 * Objects one alarm reads before it yields and re-arms. Each read is one R2 GET plus a gunzip, a
 * schema parse and a SHA-256 of at most 500 events, so a slice stays well inside an alarm's CPU
 * (30 s) and subrequest (10,000) limits. `AUDIT_VERIFY_SLICE_OBJECTS` overrides it; only the test
 * config sets it, to force a pass across many slices.
 */
export const VERIFY_SLICE_OBJECTS = 1000;
/** A slice that throws (R2 or a Durable Object hop) is retried this many times, then paged. */
const MAX_SLICE_ERRORS = 5;
const SLICE_ERROR_RETRY_MS = 60_000;
/** Design 8.1 runs the full pass monthly; it pages once one has not completed in this window. */
export const FULL_PASS_DEADLINE_MS = 35 * 24 * 60 * 60 * 1000;

const VERIFIED_CHECKPOINT_KEY = 'verified_checkpoint';
const FULL_COMPLETED_AT_KEY = 'full_completed_at';
const FULL_BASELINE_AT_KEY = 'full_baseline_at';

function lastResultKey(kind: VerifyPassKind): string {
  return `last:${kind}`;
}

function passKey(kind: VerifyPassKind): string {
  return `pass:${kind}`;
}

/**
 * One verification pass in progress. `from` holds the anchor checkpoint's entries (empty for a
 * full pass, so every stream starts at genesis) and `checkpoint` the newest checkpoint's entries,
 * which the chain must land on. `cursor` is the stream being walked and the last position it
 * verified; streams before it in name order are done.
 */
type VerifyPass = {
  kind: VerifyPassKind;
  startedAt: number;
  anchorKey: string | null;
  targetKey: string | null;
  from: Record<string, ChainPosition>;
  checkpoint: Record<string, ChainPosition>;
  cursor: { stream: string; position: ChainPosition } | null;
  objects: number;
  errors: number;
};

export type StartPassResult =
  | { kind: 'started'; pass: VerifyPassKind; anchorKey: string | null; targetKey: string | null }
  | { kind: 'running'; pass: VerifyPassKind }
  | { kind: 'failed'; pass: VerifyPassKind; reason: VerifyFailureReason; detail: string };

type SliceResult =
  | { kind: 'idle' }
  | { kind: 'progress'; pass: VerifyPassKind; objects: number }
  | { kind: 'retry'; pass: VerifyPassKind; errors: number }
  | { kind: 'completed'; pass: VerifyPassKind; objects: number; targetKey: string | null }
  | { kind: 'failed'; pass: VerifyPassKind; reason: VerifyFailureReason; detail: string };

/** The outcome of the last finished pass of a kind, kept for operators and tests. */
export type PassResult =
  | {
      outcome: 'completed';
      at: number;
      objects: number;
      anchorKey: string | null;
      targetKey: string | null;
    }
  | { outcome: 'failed'; at: number; reason: VerifyFailureReason; detail: string };

export type VerifierStatus = {
  running: VerifyPassKind[];
  lastVerifiedCheckpoint: string | null;
  daily: PassResult | null;
  full: PassResult | null;
};

/**
 * Owns archive verification (design 8.1). A cron starts a pass; the pass then walks the archive
 * in bounded slices, one per alarm, saving a per-stream cursor between slices, so neither a long
 * archive nor a large backlog ever has to fit one invocation.
 */
export class VerifierDO extends DurableObject<Env> {
  async startPass(kind: VerifyPassKind, now: number = Date.now()): Promise<StartPassResult> {
    if (kind === 'daily') await this.pageIfFullPassOverdue(now);
    if (await this.ctx.storage.get<VerifyPass>(passKey(kind))) return { kind: 'running', pass: kind };

    const verified = (await this.ctx.storage.get<string>(VERIFIED_CHECKPOINT_KEY)) ?? null;
    const anchorKey = kind === 'daily' ? verified : null;
    let targetKey: string | null;
    let anchor: CheckpointFile | null = null;
    let target: CheckpointFile | null = null;
    try {
      targetKey = (await newestCheckpointKeyAfter(this.env.AUDIT_ARCHIVE, verified)) ?? verified;
      if (anchorKey) anchor = await this.readSignedCheckpoint(anchorKey);
      if (targetKey) target = await this.readSignedCheckpoint(targetKey);
    } catch (error) {
      const failure =
        error instanceof CheckpointRejectedError
          ? { reason: error.reason, detail: error.message }
          : { reason: 'checkpoint_read' as const, detail: errorName(error) };
      await this.reportFailure(kind, failure.reason, failure.detail);
      return { kind: 'failed', pass: kind, ...failure };
    }

    const pass: VerifyPass = {
      kind,
      startedAt: now,
      anchorKey,
      targetKey,
      from: positionsOf(anchor),
      checkpoint: positionsOf(target),
      cursor: null,
      objects: 0,
      errors: 0,
    };
    await this.ctx.storage.put(passKey(kind), pass);
    await this.ctx.storage.setAlarm(Date.now());
    return { kind: 'started', pass: kind, anchorKey, targetKey };
  }

  async status(): Promise<VerifierStatus> {
    const storage = this.ctx.storage;
    const [verified, daily, full, dailyResult, fullResult] = await Promise.all([
      storage.get<string>(VERIFIED_CHECKPOINT_KEY),
      storage.get<VerifyPass>(passKey('daily')),
      storage.get<VerifyPass>(passKey('full')),
      storage.get<PassResult>(lastResultKey('daily')),
      storage.get<PassResult>(lastResultKey('full')),
    ]);
    const running: VerifyPassKind[] = [];
    if (daily) running.push('daily');
    if (full) running.push('full');
    return {
      running,
      lastVerifiedCheckpoint: verified ?? null,
      daily: dailyResult ?? null,
      full: fullResult ?? null,
    };
  }

  async alarm(): Promise<void> {
    const result = await this.runSlice(this.sliceBudget());
    if (result.kind === 'idle') return;
    if (result.kind === 'retry') {
      await this.ctx.storage.setAlarm(Date.now() + SLICE_ERROR_RETRY_MS);
      return;
    }
    if (await this.nextPass()) await this.ctx.storage.setAlarm(Date.now());
  }

  /** Walks at most `budget` objects of one pass: the daily pass first, then the full pass. */
  private async runSlice(budget: number): Promise<SliceResult> {
    const pass = await this.nextPass();
    if (!pass) return { kind: 'idle' };
    try {
      return await this.walkPass(pass, budget);
    } catch (error) {
      const errors = pass.errors + 1;
      console.error(
        JSON.stringify({
          event: 'audit_relay.verification_slice_error',
          pass: pass.kind,
          errors,
          error: errorName(error),
        })
      );
      if (errors < MAX_SLICE_ERRORS) {
        await this.ctx.storage.put(passKey(pass.kind), { ...pass, errors });
        return { kind: 'retry', pass: pass.kind, errors };
      }
      return this.failPass(pass, 'archive_read', `slice failed ${errors} times: ${errorName(error)}`);
    }
  }

  private async walkPass(pass: VerifyPass, budget: number): Promise<SliceResult> {
    const heads = await withDORetry(
      () => getRegistryDOStub(this.env),
      stub => stub.listStreams(),
      'listStreams'
    );
    const registered = new Set(heads.map(head => head.stream));
    const unknown = Object.keys(pass.checkpoint).find(stream => !registered.has(stream));
    if (unknown !== undefined) {
      return this.failPass(pass, 'head', `stream ${unknown} is in the checkpoint, not the registry`);
    }

    let index = 0;
    if (pass.cursor) {
      const cursorStream = pass.cursor.stream;
      index = heads.findIndex(head => head.stream === cursorStream);
      if (index < 0) {
        return this.failPass(pass, 'head', `stream ${cursorStream} left the registry`);
      }
    }

    let remaining = budget;
    let objects = pass.objects;
    for (; index < heads.length; index += 1) {
      const head = heads[index];
      const resume = pass.cursor?.stream === head.stream ? pass.cursor.position : null;
      const walk = await walkStream(this.env.AUDIT_ARCHIVE, {
        stream: head.stream,
        from: resume ?? pass.from[head.stream] ?? { seq: 0, hash: GENESIS_HASH },
        checkpoint: pass.checkpoint[head.stream] ?? null,
        head,
        budget: remaining,
      });
      if (walk.kind === 'failed') return this.failPass(pass, walk.reason, walk.detail);
      remaining -= walk.objects;
      objects += walk.objects;
      if (walk.kind === 'paused') {
        await this.ctx.storage.put(passKey(pass.kind), {
          ...pass,
          cursor: { stream: head.stream, position: walk.position },
          objects,
          errors: 0,
        });
        return { kind: 'progress', pass: pass.kind, objects };
      }
    }

    return this.completePass(pass, objects);
  }

  private async completePass(pass: VerifyPass, objects: number): Promise<SliceResult> {
    const now = Date.now();
    // No await between these writes, so the storage commits them atomically: a crash can neither
    // repeat a finished pass nor lose the anchor it earned.
    const result: PassResult = {
      outcome: 'completed',
      at: now,
      objects,
      anchorKey: pass.anchorKey,
      targetKey: pass.targetKey,
    };
    const writes: Promise<unknown>[] = [
      this.ctx.storage.delete(passKey(pass.kind)),
      this.ctx.storage.put(lastResultKey(pass.kind), result),
    ];
    if (pass.kind === 'daily' && pass.targetKey) {
      writes.push(this.ctx.storage.put(VERIFIED_CHECKPOINT_KEY, pass.targetKey));
    }
    if (pass.kind === 'full') writes.push(this.ctx.storage.put(FULL_COMPLETED_AT_KEY, now));
    await Promise.all(writes);
    console.log(
      JSON.stringify({
        event: 'audit_relay.verification_completed',
        pass: pass.kind,
        objects,
        anchorKey: pass.anchorKey,
        targetKey: pass.targetKey,
        durationMs: now - pass.startedAt,
      })
    );
    return { kind: 'completed', pass: pass.kind, objects, targetKey: pass.targetKey };
  }

  private async failPass(
    pass: VerifyPass,
    reason: VerifyFailureReason,
    detail: string
  ): Promise<SliceResult> {
    await this.ctx.storage.delete(passKey(pass.kind));
    await this.reportFailure(pass.kind, reason, detail);
    return { kind: 'failed', pass: pass.kind, reason, detail };
  }

  /** Records the failure as the kind's last result, logs it and pages; the anchor stays put. */
  private async reportFailure(
    kind: VerifyPassKind,
    reason: VerifyFailureReason,
    detail: string
  ): Promise<void> {
    const result: PassResult = { outcome: 'failed', at: Date.now(), reason, detail };
    await this.ctx.storage.put(lastResultKey(kind), result);
    console.error(
      JSON.stringify({ event: 'audit_relay.verification_failed', pass: kind, reason, detail })
    );
    await pageOperator(
      this.env,
      `audit-relay ${kind} chain verification failed (${reason}): ${detail}`,
      this.ctx
    );
  }

  private sliceBudget(): number {
    const configured = Number(this.env.AUDIT_VERIFY_SLICE_OBJECTS);
    return Number.isInteger(configured) && configured > 0 ? configured : VERIFY_SLICE_OBJECTS;
  }

  private async nextPass(): Promise<VerifyPass | null> {
    const daily = await this.ctx.storage.get<VerifyPass>(passKey('daily'));
    if (daily) return daily;
    return (await this.ctx.storage.get<VerifyPass>(passKey('full'))) ?? null;
  }

  private async readSignedCheckpoint(key: string): Promise<CheckpointFile> {
    const file = await readCheckpointFile(this.env.AUDIT_ARCHIVE, key);
    if (!file) throw new CheckpointRejectedError('checkpoint_read', `checkpoint ${key} is missing`);
    if (!(await checkpointSignatureValid(await readPublicKeys(this.env), file))) {
      throw new CheckpointRejectedError('checkpoint_signature', key);
    }
    return file;
  }

  private async pageIfFullPassOverdue(now: number): Promise<void> {
    let since = await this.ctx.storage.get<number>(FULL_COMPLETED_AT_KEY);
    if (since === undefined) {
      since = await this.ctx.storage.get<number>(FULL_BASELINE_AT_KEY);
      if (since === undefined) {
        await this.ctx.storage.put(FULL_BASELINE_AT_KEY, now);
        return;
      }
    }
    if (now - since <= FULL_PASS_DEADLINE_MS) return;
    const days = Math.floor((now - since) / (24 * 60 * 60 * 1000));
    console.error(JSON.stringify({ event: 'audit_relay.full_verification_overdue', days }));
    await pageOperator(
      this.env,
      `audit-relay full chain verification has not completed for ${days} days`,
      this.ctx
    );
  }
}

class CheckpointRejectedError extends Error {
  constructor(
    readonly reason: 'checkpoint_read' | 'checkpoint_signature',
    message: string
  ) {
    super(message);
    this.name = 'CheckpointRejectedError';
  }
}

function positionsOf(file: CheckpointFile | null): Record<string, ChainPosition> {
  const positions: Record<string, ChainPosition> = {};
  for (const entry of file?.streams ?? []) {
    positions[entry.stream] = { seq: entry.seq, hash: entry.hash };
  }
  return positions;
}

export function getVerifierDOStub(env: Pick<Env, 'AUDIT_VERIFIER'>): DurableObjectStub<VerifierDO> {
  return env.AUDIT_VERIFIER.get(env.AUDIT_VERIFIER.idFromName('verifier'));
}
