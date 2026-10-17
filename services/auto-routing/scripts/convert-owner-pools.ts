import { parseArgs } from 'node:util';
import {
  OWNER_POOL_CONVERSION_SCAN_PATH,
  OwnerPoolConversionOutcomeSchema,
  OwnerPoolConversionScanResponseSchema,
  type OwnerPoolConversionOutcome,
  type OwnerPoolConversionScanResponse,
} from '@kilocode/auto-routing-contracts';

const DEFAULT_ACCOUNT_ID = 'e115e769bcdd4c3d66af59d3332cb394';
const SCRIPT_NAME = 'auto-routing';
const CLASS_NAME = 'AutoRoutingModeConfigDO';
const OWNER_TYPES = ['user', 'org'] as const;
type OwnerType = (typeof OWNER_TYPES)[number];

type CloudflarePage<T> = {
  success: boolean;
  errors?: { message: string }[];
  result: T[];
  result_info?: { cursor?: string; page?: number; total_pages?: number };
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function cloudflareGet<T>(token: string, path: string): Promise<CloudflarePage<T>> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json()) as CloudflarePage<T>;
  if (!response.ok || !body.success) {
    throw new Error(
      `Cloudflare ${path.split('?')[0]} responded ${response.status}: ${body.errors?.map(e => e.message).join('; ') ?? ''}`
    );
  }
  return body;
}

async function findNamespaceId(token: string, accountId: string): Promise<string> {
  for (let page = 1; ; page++) {
    const body = await cloudflareGet<{ id: string; script?: string; class?: string }>(
      token,
      `/accounts/${accountId}/workers/durable_objects/namespaces?page=${page}&per_page=100`
    );
    const namespace = body.result.find(
      entry => entry.script === SCRIPT_NAME && entry.class === CLASS_NAME
    );
    if (namespace) return namespace.id;
    const totalPages = body.result_info?.total_pages ?? page;
    if (body.result.length === 0 || page >= totalPages) {
      throw new Error(`Durable Object namespace ${SCRIPT_NAME}/${CLASS_NAME} not found`);
    }
  }
}

async function listStoredObjectIds(
  token: string,
  accountId: string,
  namespaceId: string
): Promise<string[]> {
  const ids: string[] = [];
  let cursor = '';
  do {
    const body = await cloudflareGet<{ id: string; hasStoredData?: boolean }>(
      token,
      `/accounts/${accountId}/workers/durable_objects/namespaces/${namespaceId}/objects?limit=10000&cursor=${encodeURIComponent(cursor)}`
    );
    for (const object of body.result) {
      if (object.hasStoredData) ids.push(object.id);
    }
    cursor = body.result_info?.cursor ?? '';
  } while (cursor);
  return ids;
}

// `<type>:` with an empty cursor starts that owner type from its first id.
function parseResume(
  value: string | undefined
): { ownerType: OwnerType; cursor: string | null } | null {
  if (value === undefined) return null;
  const separator = value.indexOf(':');
  const ownerType = OWNER_TYPES.find(type => type === value.slice(0, separator));
  if (separator < 1 || ownerType === undefined) {
    throw new Error('--resume must be <user|org>:<cursor> (an empty cursor starts that type)');
  }
  return { ownerType, cursor: value.slice(separator + 1) || null };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      resume: { type: 'string' },
      limit: { type: 'string', default: '500' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: pnpm exec tsx scripts/convert-owner-pools.ts [--dry-run] [--resume <user|org>:<cursor>] [--limit 500]\n' +
        'Env: CLOUDFLARE_API_TOKEN, INTERNAL_API_SECRET, optional CLOUDFLARE_ACCOUNT_ID and AUTO_ROUTING_URL (default https://auto-routing.kiloapps.io).'
    );
    return;
  }
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error('--limit must be an integer between 1 and 10000');
  }
  const resume = parseResume(values.resume);
  const dryRun = values['dry-run'];
  const token = requireEnv('CLOUDFLARE_API_TOKEN');
  const secret = requireEnv('INTERNAL_API_SECRET');
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || DEFAULT_ACCOUNT_ID;
  const target = new URL(
    OWNER_POOL_CONVERSION_SCAN_PATH,
    process.env.AUTO_ROUTING_URL?.trim() || 'https://auto-routing.kiloapps.io'
  );

  const namespaceId = await findNamespaceId(token, accountId);
  const objectIds = await listStoredObjectIds(token, accountId, namespaceId);
  console.log(`Listed ${objectIds.length} ${CLASS_NAME} objects with stored data`);

  const matched = new Set<string>();
  const outcomes = Object.fromEntries(
    OwnerPoolConversionOutcomeSchema.options.map(outcome => [outcome, 0])
  ) as Record<OwnerPoolConversionOutcome, number>;
  const readFailed: string[] = [];
  const invalidPool: string[] = [];
  const invalidMode: string[] = [];
  const needsAttention: string[] = [];
  let alreadyConverted = 0;
  let conversions = 0;
  let droppedModeOnly = 0;
  let noticesSent = 0;
  let noticesFailed = 0;
  // Owner keys are printed as each page arrives: those owners are marked converted, so a rerun
  // after a crash skips them and could not report them again.
  const add = (result: OwnerPoolConversionScanResponse) => {
    for (const id of result.matchedObjectIds) matched.add(id);
    for (const outcome of OwnerPoolConversionOutcomeSchema.options) {
      outcomes[outcome] += result.outcomes[outcome] ?? 0;
    }
    for (const [label, keys] of [
      ['readFailed', result.readFailed],
      ['invalidPool', result.invalidPool],
      ['invalidMode', result.invalidMode],
      ['needsAttention', result.needsAttention],
    ] as const) {
      for (const key of keys) console.log(`${label}: ${key}`);
    }
    readFailed.push(...result.readFailed);
    invalidPool.push(...result.invalidPool);
    invalidMode.push(...result.invalidMode);
    needsAttention.push(...result.needsAttention);
    alreadyConverted += result.alreadyConverted;
    conversions += result.conversions;
    droppedModeOnly += result.droppedModeOnly;
    noticesSent += result.noticesSent;
    noticesFailed += result.noticesFailed;
  };
  let completed = false;
  const printSummary = () => {
    const unmatched = resume || !completed ? null : objectIds.filter(id => !matched.has(id));
    console.log(
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
          noticesSent,
          noticesFailed,
        },
        null,
        2
      )
    );
    if (unmatched === null) {
      console.log('Audit unmatched objects with a full --dry-run from the start.');
    } else if (unmatched.length > 0) {
      console.log(`Unmatched object ids:\n${unmatched.join('\n')}`);
    }
    return (
      completed &&
      readFailed.length === 0 &&
      invalidPool.length === 0 &&
      invalidMode.length === 0 &&
      needsAttention.length === 0 &&
      noticesFailed === 0 &&
      (unmatched?.length ?? 0) === 0
    );
  };

  try {
    const startIndex = resume ? OWNER_TYPES.indexOf(resume.ownerType) : 0;
    for (const ownerType of OWNER_TYPES.slice(startIndex)) {
      let after: string | null = resume?.ownerType === ownerType ? resume.cursor : null;
      do {
        // Converted owners are marked in their Durable Object, so retrying a page skips them.
        const retryHint = `retry with --resume ${ownerType}:${after ?? ''}`;
        let response: Response;
        let body: unknown;
        try {
          response = await fetch(target, {
            method: 'POST',
            headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
            body: JSON.stringify({ ownerType, objectIds, after, limit, dryRun }),
            signal: AbortSignal.timeout(300_000),
            redirect: 'error',
          });
          body = await response.json();
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'scan failed';
          throw new Error(
            `${reason}; ${retryHint}. Owners reported failed on an interrupted page may have a router without a notice; check them by hand.`
          );
        }
        const result = OwnerPoolConversionScanResponseSchema.safeParse(body);
        if (!result.success) {
          throw new Error(`scan responded ${response.status} without a summary; ${retryHint}`);
        }
        add(result.data);
        if (result.data.aborted) {
          throw new Error(
            `the web endpoint failed a whole batch; ${retryHint}. To skip a single owner that keeps failing, resume after its id: --resume ${ownerType}:<ownerId>.`
          );
        }
        after = result.data.nextCursor;
        console.log(
          `${ownerType}: scanned ${result.data.scanned}, matched ${result.data.matchedObjectIds.length}, conversions ${result.data.conversions}; cursor ${after === null ? 'done' : `${ownerType}:${after}`}`
        );
      } while (after !== null);
    }
    completed = true;
  } finally {
    if (!printSummary()) {
      console.error(
        'Some owners need attention; see readFailed, invalidPool, invalidMode, needsAttention, and unmatched.'
      );
      process.exitCode = 1;
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Owner pool conversion failed');
  process.exitCode = 1;
});
