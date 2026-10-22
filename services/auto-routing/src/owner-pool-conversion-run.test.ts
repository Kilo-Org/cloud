import { describe, expect, it, vi } from 'vitest';
import type { OwnerPoolConversionScanResponse } from '@kilocode/auto-routing-contracts';
import {
  runOwnerPoolConversion,
  type ScanPage,
  type ScanPageRequest,
} from './owner-pool-conversion-run';

const NO_OUTCOMES = {
  created: 0,
  exists: 0,
  slug_taken: 0,
  router_cap_reached: 0,
  owner_not_found: 0,
  failed: 0,
};

function page(overrides: Partial<OwnerPoolConversionScanResponse> = {}) {
  return {
    status: 200,
    body: {
      scanned: 1,
      nextCursor: null,
      matchedObjectIds: [],
      alreadyConverted: 0,
      conversions: 0,
      droppedModeOnly: 0,
      readFailed: [],
      invalidPool: [],
      invalidMode: [],
      needsAttention: [],
      outcomes: NO_OUTCOMES,
      noticesSent: 0,
      noticesFailed: 0,
      aborted: false,
      notPosted: [],
      abortReason: null,
      consecutiveFailed: 0,
      ...overrides,
    },
  };
}

function run(scan: ScanPage, options: Partial<Parameters<typeof runOwnerPoolConversion>[0]> = {}) {
  const lines: string[] = [];
  const result = runOwnerPoolConversion({
    objectIds: ['a', 'b'],
    resume: null,
    dryRun: false,
    scan,
    log: line => lines.push(line),
    ...options,
  });
  return { result, lines };
}

function summaryOf(lines: readonly string[]): Record<string, unknown> {
  const summary = lines.find(line => line.startsWith('{'));
  if (!summary) throw new Error('No summary was printed');
  return JSON.parse(summary) as Record<string, unknown>;
}

describe('runOwnerPoolConversion', () => {
  it('carries the failure run between pages and starts each owner type at zero', async () => {
    const requests: ScanPageRequest[] = [];
    const scan = vi.fn<ScanPage>(async request => {
      requests.push(request);
      if (request.ownerType === 'user' && request.after === null) {
        return page({ nextCursor: 'u9', consecutiveFailed: 3, matchedObjectIds: ['a'] });
      }
      return page({
        consecutiveFailed: 2,
        matchedObjectIds: request.ownerType === 'org' ? ['b'] : [],
      });
    });

    const { result, lines } = run(scan);

    await expect(result).resolves.toEqual({ completed: true, clean: true, error: null });
    expect(requests).toEqual([
      { ownerType: 'user', after: null, consecutiveFailed: 0 },
      { ownerType: 'user', after: 'u9', consecutiveFailed: 3 },
      { ownerType: 'org', after: null, consecutiveFailed: 0 },
    ]);
    expect(summaryOf(lines)).toMatchObject({ completed: true, matched: 2, unmatched: 0 });
  });

  it('prints the summary of the pages so far when a page fails, and is never clean', async () => {
    const scan = vi.fn<ScanPage>(async request => {
      if (request.after === null) {
        return page({
          nextCursor: 'u5',
          needsAttention: ['exists user:u1'],
          matchedObjectIds: ['a'],
        });
      }
      throw new Error('The operation was aborted due to timeout');
    });

    const { result, lines } = run(scan);
    const outcome = await result;

    expect(outcome.completed).toBe(false);
    expect(outcome.clean).toBe(false);
    expect(outcome.error?.message).toContain('retry with --resume user:u5');
    expect(lines).toContain('needsAttention: exists user:u1');
    expect(summaryOf(lines)).toMatchObject({
      completed: false,
      unmatched: 'not audited on a resumed or interrupted run',
      needsAttention: ['exists user:u1'],
    });
  });

  it('names the last failing owner to resume past when repeated failures stop a page', async () => {
    const scan = vi.fn<ScanPage>(async () =>
      page({
        aborted: true,
        abortReason: 'consecutive_failures',
        needsAttention: ['failed user:u3', 'slug_taken user:u4', 'failed user:u7'],
        notPosted: ['user:u8'],
      })
    );

    const { result, lines } = run(scan);
    const outcome = await result;

    expect(outcome.error?.message).toContain('--resume user:u7 skips them');
    expect(outcome.error?.message).not.toContain('<ownerId>');
    expect(summaryOf(lines)).toMatchObject({ completed: false, notPosted: ['user:u8'] });
  });

  it('offers no skip on a failed batch, since nothing points at a failing owner', async () => {
    const scan = vi.fn<ScanPage>(async () =>
      page({
        aborted: true,
        abortReason: 'batch_failed',
        needsAttention: ['failed user:u3'],
        notPosted: ['user:u4'],
      })
    );

    const { error } = await run(scan).result;

    expect(error?.message).toContain('(batch_failed)');
    expect(error?.message).not.toContain('skips them');
  });

  it('stops on a response without a summary', async () => {
    const scan = vi.fn<ScanPage>(async () => ({ status: 502, body: { error: 'bad gateway' } }));

    const { error, completed } = await run(scan).result;

    expect(completed).toBe(false);
    expect(error?.message).toBe('scan responded 502 without a summary; retry with --resume user:');
  });

  it('resumes at the given owner type and cursor, and skips the unmatched audit', async () => {
    const requests: ScanPageRequest[] = [];
    const scan = vi.fn<ScanPage>(async request => {
      requests.push(request);
      return page();
    });

    const { result, lines } = run(scan, { resume: { ownerType: 'org', cursor: 'o5' } });

    await expect(result).resolves.toEqual({ completed: true, clean: true, error: null });
    expect(requests).toEqual([{ ownerType: 'org', after: 'o5', consecutiveFailed: 0 }]);
    expect(summaryOf(lines)).toMatchObject({
      unmatched: 'not audited on a resumed or interrupted run',
    });
  });

  it('is not clean when a completed run leaves owners to handle or objects unmatched', async () => {
    const withAttention = await run(
      vi.fn<ScanPage>(async () => page({ matchedObjectIds: ['a', 'b'], noticesFailed: 1 }))
    ).result;
    const withUnmatched = await run(vi.fn<ScanPage>(async () => page({ matchedObjectIds: ['a'] })))
      .result;

    expect(withAttention).toMatchObject({ completed: true, clean: false });
    expect(withUnmatched).toMatchObject({ completed: true, clean: false });
  });
});
