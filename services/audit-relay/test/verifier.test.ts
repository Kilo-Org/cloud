import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkpointKey, createHourlyCheckpoint, readCheckpointFile } from '../src/checkpoint';
import { getStreamDOStub } from '../src/dos/StreamDO';
import {
  CHECKPOINT_MAX_AGE_MS,
  FULL_PASS_DEADLINE_MS,
  MAX_SLICE_ERRORS,
  getVerifierDOStub,
} from '../src/dos/VerifierDO';
import { archiveObjectKey, gzipJson } from '../src/relay/archive';
import {
  auditBatch,
  axiomOk,
  env,
  pageTexts,
  readArchived,
  recordingFetch,
  uniqueStream,
  verifierStatus,
  type VerifierState,
} from './helpers';

const HALF_HOUR = 30 * 60 * 1000;

const hour = (h: number) => Date.UTC(2026, 10, 25, h, 0, 0);
const hourKey = (h: number) => checkpointKey(new Date(hour(h)).toISOString());

async function archive(stream: string, fromSeq: number, toSeq: number): Promise<void> {
  const outcome = await getStreamDOStub(env, stream).acceptBatch(
    auditBatch(fromSeq, toSeq, stream)
  );
  if (outcome.kind !== 'accepted') throw new Error(`expected accepted, got ${outcome.kind}`);
}

/** Rewrites one archived event's optional field and returns a function that restores it. */
async function tamper(stream: string, toSeq: number): Promise<() => Promise<void>> {
  const key = archiveObjectKey(stream, toSeq);
  const original = await env.AUDIT_ARCHIVE.get(key);
  if (!original) throw new Error(`archive object ${key} missing`);
  const bytes = new Uint8Array(await original.arrayBuffer());
  const stored = await readArchived(stream, toSeq);
  const [first, ...rest] = stored.batch.events;
  await env.AUDIT_ARCHIVE.put(
    key,
    await gzipJson({
      ...stored,
      batch: {
        ...stored.batch,
        events: [{ ...first, data: { ...first.data, outcomeDetail: 'tampered' } }, ...rest],
      },
    })
  );
  return async () => {
    await env.AUDIT_ARCHIVE.put(key, bytes);
  };
}

const verifier = () => getVerifierDOStub(env);

/** Waits until the alarm-driven slices finish every running pass. */
async function settled(): Promise<VerifierState> {
  return vi.waitFor(
    async () => {
      const status = await verifierStatus(verifier());
      if (status.running.length > 0) throw new Error(`still running: ${status.running}`);
      return status;
    },
    { timeout: 10_000, interval: 20 }
  );
}

describe('VerifierDO', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // One scenario: the verifier, the registry and the checkpoints are singletons shared by every
  // test in this file, so each step depends on the anchor and archive the previous step left.
  it('anchors daily passes on the last verified checkpoint and pages every failure', async () => {
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const alpha = uniqueStream('verify-alpha');
    const beta = uniqueStream('verify-beta');

    // First daily pass: no anchor yet, so every stream is walked from genesis to the newest
    // checkpoint. Two objects per slice force the cursor across slices and across streams.
    await archive(alpha, 1, 2);
    await archive(alpha, 3, 4);
    await archive(alpha, 5, 5);
    await archive(beta, 1, 3);
    await createHourlyCheckpoint(env, hour(1));
    expect(await verifier().startPass('daily', hour(1) + HALF_HOUR)).toEqual({
      kind: 'started',
      pass: 'daily',
      anchorKey: null,
      targetKey: hourKey(1),
    });
    let status = await settled();
    expect(status.lastVerifiedCheckpoint).toBe(hourKey(1));
    expect(status.daily).toMatchObject({ outcome: 'completed', objects: 4, anchorKey: null });

    // An object below the anchor is the full pass's job: the daily pass starts after the anchor
    // and reads only the objects archived since.
    await archive(alpha, 6, 7);
    await archive(beta, 4, 4);
    await createHourlyCheckpoint(env, hour(2));
    const restoreAlpha2 = await tamper(alpha, 2);
    expect(await verifier().startPass('daily', hour(2) + HALF_HOUR)).toMatchObject({
      kind: 'started',
      anchorKey: hourKey(1),
      targetKey: hourKey(2),
    });
    status = await settled();
    expect(status.daily).toMatchObject({ outcome: 'completed', objects: 2 });
    expect(status.lastVerifiedCheckpoint).toBe(hourKey(2));

    expect(await verifier().startPass('full')).toMatchObject({ kind: 'started', anchorKey: null });
    status = await settled();
    expect(status.full).toMatchObject({ outcome: 'failed', reason: 'chain' });
    expect(pageTexts(http.requests).at(-1)).toMatch(
      /^bot: audit-relay full chain verification failed \(chain\): stream .*verify-alpha/
    );
    await restoreAlpha2();
    await verifier().startPass('full');
    status = await settled();
    expect(status.full).toMatchObject({ outcome: 'completed', objects: 6 });

    // An object above the anchor fails the daily pass, and the anchor stays where it was.
    await archive(alpha, 8, 9);
    const restoreAlpha9 = await tamper(alpha, 9);
    await verifier().startPass('daily', hour(2) + HALF_HOUR);
    status = await settled();
    expect(status.daily).toMatchObject({ outcome: 'failed', reason: 'chain' });
    expect(status.lastVerifiedCheckpoint).toBe(hourKey(2));
    await restoreAlpha9();

    // A forged newest checkpoint fails before any object is read.
    await createHourlyCheckpoint(env, hour(3));
    const signed = await readCheckpointFile(env.AUDIT_ARCHIVE, hourKey(3));
    if (!signed) throw new Error('checkpoint missing');
    await env.AUDIT_ARCHIVE.put(
      hourKey(3),
      JSON.stringify({ ...signed, streams: [{ stream: alpha, seq: 9, hash: 'a'.repeat(64) }] })
    );
    expect(await verifier().startPass('daily', hour(3) + HALF_HOUR)).toMatchObject({
      kind: 'failed',
      reason: 'checkpoint_signature',
    });
    expect((await verifierStatus(verifier())).lastVerifiedCheckpoint).toBe(hourKey(2));
    expect(pageTexts(http.requests).at(-1)).toMatch(
      /^bot: audit-relay daily chain verification failed \(checkpoint_signature\)/
    );

    // The daily cron pages while no full pass has completed inside the deadline.
    const pagesBefore = pageTexts(http.requests).length;
    // The last full pass completed moments ago (real clock), so measure from now.
    await verifier().startPass('daily', Date.now() + FULL_PASS_DEADLINE_MS + 86_400_000);
    expect(pageTexts(http.requests).slice(pagesBefore)).toContainEqual(
      expect.stringMatching(
        /^bot: audit-relay full chain verification has not completed for 36 days$/
      )
    );
  });
});

describe('VerifierDO slices', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails and pages a pass whose slices keep ending without finishing', async () => {
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const stub = verifier();
    // What five slices killed by the runtime (CPU limit, eviction) leave: each counted itself
    // before it walked and never saved progress.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('pass:full', {
        kind: 'full',
        startedAt: Date.now(),
        anchorKey: null,
        targetKey: null,
        from: {},
        checkpoint: {},
        cursor: null,
        objects: 0,
        errors: MAX_SLICE_ERRORS,
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const status = await verifierStatus(stub);
    expect(status.running).toEqual([]);
    expect(status.full).toMatchObject({
      outcome: 'failed',
      reason: 'archive_read',
      detail: `${MAX_SLICE_ERRORS} slices in a row ended without finishing`,
    });
    expect(pageTexts(http.requests)).toEqual([
      `bot: audit-relay full chain verification failed (archive_read): ${MAX_SLICE_ERRORS} slices in a row ended without finishing`,
    ]);
  });

  it('fails and pages a daily pass whose newest checkpoint is too old', async () => {
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    await createHourlyCheckpoint(env, hour(5));
    const now = hour(5) + CHECKPOINT_MAX_AGE_MS + 60 * 60 * 1000;

    expect(await verifier().startPass('daily', now)).toEqual({
      kind: 'failed',
      pass: 'daily',
      reason: 'checkpoint_stale',
      detail: `newest checkpoint ${hourKey(5)} is 3 h old`,
    });
    expect(pageTexts(http.requests)).toContain(
      `bot: audit-relay daily chain verification failed (checkpoint_stale): newest checkpoint ${hourKey(5)} is 3 h old`
    );
  });
});
