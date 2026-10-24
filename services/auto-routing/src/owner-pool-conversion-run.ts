import {
  OwnerPoolConversionOutcomeSchema,
  OwnerPoolConversionScanResponseSchema,
  type OwnerType,
  type OwnerPoolConversionOutcome,
  type OwnerPoolConversionScanResponse,
} from '@kilocode/auto-routing-contracts';

export const OWNER_TYPES = ['user', 'org'] as const satisfies readonly OwnerType[];

export type ScanPageRequest = {
  ownerType: OwnerType;
  after: string | null;
  consecutiveFailed: number;
};

// Throws on a transport failure (network error or timeout).
export type ScanPage = (request: ScanPageRequest) => Promise<{ status: number; body: unknown }>;

export type ConversionRunResult = {
  completed: boolean;
  // Exit 0 only when the run completed and nothing needs the operator.
  clean: boolean;
  error: Error | null;
};

export async function runOwnerPoolConversion(params: {
  objectIds: readonly string[];
  resume: { ownerType: OwnerType; cursor: string | null } | null;
  dryRun: boolean;
  scan: ScanPage;
  log: (line: string) => void;
}): Promise<ConversionRunResult> {
  const { objectIds, resume, dryRun, scan, log } = params;
  const matched = new Set<string>();
  const outcomes = Object.fromEntries(
    OwnerPoolConversionOutcomeSchema.options.map(outcome => [outcome, 0])
  ) as Record<OwnerPoolConversionOutcome, number>;
  const readFailed: string[] = [];
  const invalidPool: string[] = [];
  const invalidMode: string[] = [];
  const needsAttention: string[] = [];
  const notPosted: string[] = [];
  let alreadyConverted = 0;
  let conversions = 0;
  let droppedModeOnly = 0;
  let noticesSent = 0;
  let noticesFailed = 0;

  // Owner keys are printed as each page arrives so a crash later in the run cannot lose them;
  // settled owners are marked in their Durable Object and a rerun would not report them again.
  const add = (page: OwnerPoolConversionScanResponse) => {
    for (const id of page.matchedObjectIds) matched.add(id);
    for (const outcome of OwnerPoolConversionOutcomeSchema.options) {
      outcomes[outcome] += page.outcomes[outcome] ?? 0;
    }
    for (const [label, keys] of [
      ['readFailed', page.readFailed],
      ['invalidPool', page.invalidPool],
      ['invalidMode', page.invalidMode],
      ['needsAttention', page.needsAttention],
      ['notPosted', page.notPosted],
    ] as const) {
      for (const key of keys) log(`${label}: ${key}`);
    }
    readFailed.push(...page.readFailed);
    invalidPool.push(...page.invalidPool);
    invalidMode.push(...page.invalidMode);
    needsAttention.push(...page.needsAttention);
    notPosted.push(...page.notPosted);
    alreadyConverted += page.alreadyConverted;
    conversions += page.conversions;
    droppedModeOnly += page.droppedModeOnly;
    noticesSent += page.noticesSent;
    noticesFailed += page.noticesFailed;
  };

  let completed = false;
  let error: Error | null = null;
  try {
    const startIndex = resume ? OWNER_TYPES.indexOf(resume.ownerType) : 0;
    for (const ownerType of OWNER_TYPES.slice(startIndex)) {
      let after: string | null = resume?.ownerType === ownerType ? resume.cursor : null;
      // An outage streak belongs to one owner type's pass.
      let consecutiveFailed = 0;
      do {
        const retryHint = `retry with --resume ${ownerType}:${after ?? ''}`;
        let response: { status: number; body: unknown };
        try {
          response = await scan({ ownerType, after, consecutiveFailed });
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : 'scan failed';
          throw new Error(
            `${reason}; ${retryHint}. Owners on the interrupted page whose router already exists come back as \`exists\`; migration does not send notices. An interrupted apply can leave legacy edits locked until a successful apply retry.`
          );
        }
        const page = OwnerPoolConversionScanResponseSchema.safeParse(response.body);
        if (!page.success) {
          throw new Error(`scan responded ${response.status} without a summary; ${retryHint}`);
        }
        add(page.data);
        consecutiveFailed = page.data.consecutiveFailed;
        if (page.data.aborted) {
          const lastFailed = page.data.needsAttention
            .filter(entry => entry.startsWith('failed '))
            .at(-1)
            ?.slice('failed '.length);
          const escape =
            page.data.abortReason === 'consecutive_failures' && lastFailed !== undefined
              ? ` If these owners keep failing, --resume ${lastFailed} skips them and posts the page's notPosted owners next. Skipped owners can remain locked against legacy edits; retry them with a full --apply after resolving their errors.`
              : ' The failed batch may already have applied; those owners come back as `exists` on the retry.';
          throw new Error(
            `the web endpoint looks unavailable (${page.data.abortReason ?? 'aborted'}); fix it, then ${retryHint}.${escape}`
          );
        }
        after = page.data.nextCursor;
        log(
          `${ownerType}: scanned ${page.data.scanned}, matched ${page.data.matchedObjectIds.length}, conversions ${page.data.conversions}; cursor ${after === null ? 'done' : `${ownerType}:${after}`}`
        );
      } while (after !== null);
    }
    completed = true;
  } catch (cause) {
    error = cause instanceof Error ? cause : new Error('Owner pool conversion failed');
  }

  // Printed on every exit, including a failure, so the run's findings are never lost.
  const unmatched = resume || !completed ? null : objectIds.filter(id => !matched.has(id));
  log(
    JSON.stringify(
      {
        dryRun,
        completed,
        listed: objectIds.length,
        matched: matched.size,
        unmatched: unmatched?.length ?? 'not audited on a resumed or interrupted run',
        alreadyConverted,
        conversions,
        outcomes,
        droppedModeOnly,
        readFailed,
        invalidPool,
        invalidMode,
        needsAttention,
        notPosted,
        noticesSent,
        noticesFailed,
      },
      null,
      2
    )
  );
  if (unmatched === null) {
    log('Audit unmatched objects with a full --dry-run from the start.');
  } else if (unmatched.length > 0) {
    log(`Unmatched object ids:\n${unmatched.join('\n')}`);
  }

  const clean =
    completed &&
    readFailed.length === 0 &&
    invalidPool.length === 0 &&
    invalidMode.length === 0 &&
    needsAttention.length === 0 &&
    notPosted.length === 0 &&
    noticesFailed === 0 &&
    (unmatched?.length ?? 0) === 0;
  return { completed, clean, error };
}
