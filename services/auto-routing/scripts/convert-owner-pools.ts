import { parseArgs } from 'node:util';

const DEFAULT_ACCOUNT_ID = 'e115e769bcdd4c3d66af59d3332cb394';
const SCRIPT_NAME = 'auto-routing';
const CLASS_NAME = 'AutoRoutingModeConfigDO';
const OWNER_TYPES = ['user', 'org'] as const;
type OwnerType = (typeof OWNER_TYPES)[number];

type ScanResponse = {
  scanned: number;
  nextCursor: string | null;
  matchedObjectIds: string[];
  conversions: number;
  droppedModeOnly: number;
  readFailed: string[];
  outcomes: Record<string, number>;
  noticesSent: number;
  noticesFailed: number;
};

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

function parseResume(value: string | undefined): { ownerType: OwnerType; cursor: string } | null {
  if (value === undefined) return null;
  const separator = value.indexOf(':');
  const ownerType = value.slice(0, separator);
  const cursor = value.slice(separator + 1);
  if (separator < 1 || !cursor || !OWNER_TYPES.includes(ownerType as OwnerType)) {
    throw new Error('--resume must be <user|org>:<cursor>');
  }
  return { ownerType: ownerType as OwnerType, cursor };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      resume: { type: 'string' },
      limit: { type: 'string', default: '2000' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: pnpm exec tsx scripts/convert-owner-pools.ts [--dry-run] [--resume <user|org>:<cursor>] [--limit 2000]\n' +
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
    '/admin/owner-pool-conversion/scan',
    process.env.AUTO_ROUTING_URL?.trim() || 'https://auto-routing.kiloapps.io'
  );

  const namespaceId = await findNamespaceId(token, accountId);
  const objectIds = await listStoredObjectIds(token, accountId, namespaceId);
  console.log(`Listed ${objectIds.length} ${CLASS_NAME} objects with stored data`);

  const matched = new Set<string>();
  const outcomes: Record<string, number> = {};
  const readFailed: string[] = [];
  let conversions = 0;
  let droppedModeOnly = 0;
  let noticesSent = 0;
  let noticesFailed = 0;

  const startIndex = resume ? OWNER_TYPES.indexOf(resume.ownerType) : 0;
  for (const ownerType of OWNER_TYPES.slice(startIndex)) {
    let after: string | null = resume?.ownerType === ownerType ? resume.cursor : null;
    do {
      const response = await fetch(target, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ownerType, objectIds, after, limit, dryRun }),
        signal: AbortSignal.timeout(300_000),
        redirect: 'error',
      });
      if (!response.ok) {
        const resumeHint = after === null ? '(start)' : `--resume ${ownerType}:${after}`;
        throw new Error(`Scan responded ${response.status}; retry with ${resumeHint}`);
      }
      const result = (await response.json()) as ScanResponse;
      for (const id of result.matchedObjectIds) matched.add(id);
      for (const [outcome, count] of Object.entries(result.outcomes)) {
        outcomes[outcome] = (outcomes[outcome] ?? 0) + count;
      }
      readFailed.push(...result.readFailed);
      conversions += result.conversions;
      droppedModeOnly += result.droppedModeOnly;
      noticesSent += result.noticesSent;
      noticesFailed += result.noticesFailed;
      after = result.nextCursor;
      console.log(
        `${ownerType}: scanned ${result.scanned}, matched ${result.matchedObjectIds.length}, conversions ${result.conversions}; cursor ${after === null ? 'done' : `${ownerType}:${after}`}`
      );
    } while (after !== null);
  }

  const unmatched = objectIds.filter(id => !matched.has(id));
  console.log(
    JSON.stringify(
      {
        dryRun,
        listed: objectIds.length,
        matched: matched.size,
        unmatched: unmatched.length,
        conversions,
        outcomes,
        droppedModeOnly,
        readFailed,
        noticesSent,
        noticesFailed,
      },
      null,
      2
    )
  );
  if (unmatched.length > 0) {
    console.log(`Unmatched object ids:\n${unmatched.join('\n')}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Owner pool conversion failed');
  process.exitCode = 1;
});
