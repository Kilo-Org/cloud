import { parseArgs } from 'node:util';
import { OWNER_POOL_CONVERSION_SCAN_PATH } from '@kilocode/auto-routing-contracts';
import * as z from 'zod';
import { OWNER_TYPES, runOwnerPoolConversion } from '../src/owner-pool-conversion-run';

const DEFAULT_ACCOUNT_ID = 'e115e769bcdd4c3d66af59d3332cb394';
const SCRIPT_NAME = 'auto-routing';
const CLASS_NAME = 'AutoRoutingModeConfigDO';
type OwnerType = (typeof OWNER_TYPES)[number];

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function cloudflareGet<T extends z.ZodType>(token: string, path: string, resultSchema: T) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
    redirect: 'error',
  });
  const body = z
    .object({
      success: z.boolean(),
      errors: z.array(z.object({ message: z.string() })).nullish(),
      result: z.array(resultSchema).nullish(),
      result_info: z
        .object({
          cursor: z.string().nullish(),
          page: z.number().int().nullish(),
          total_pages: z.number().int().nullish(),
        })
        .nullish(),
    })
    .parse(await response.json());
  if (!response.ok || !body.success) {
    throw new Error(
      `Cloudflare ${path.split('?')[0]} responded ${response.status}: ${body.errors?.map(e => e.message).join('; ') ?? ''}`
    );
  }
  return { ...body, result: body.result ?? [] };
}

async function findNamespaceId(token: string, accountId: string): Promise<string> {
  for (let page = 1; ; page++) {
    const body = await cloudflareGet(
      token,
      `/accounts/${accountId}/workers/durable_objects/namespaces?page=${page}&per_page=100`,
      z.object({ id: z.string(), script: z.string().optional(), class: z.string().optional() })
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
    const body = await cloudflareGet(
      token,
      `/accounts/${accountId}/workers/durable_objects/namespaces/${namespaceId}/objects?limit=10000&cursor=${encodeURIComponent(cursor)}`,
      z.object({ id: z.string().regex(/^[0-9a-f]{64}$/), hasStoredData: z.boolean().optional() })
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
      apply: { type: 'boolean', default: false },
      resume: { type: 'string' },
      limit: { type: 'string', default: '500' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: pnpm exec tsx scripts/convert-owner-pools.ts [--dry-run | --apply] [--resume <user|org>:<cursor>] [--limit 500]\n' +
        'Env: CLOUDFLARE_API_TOKEN, INTERNAL_API_SECRET, optional CLOUDFLARE_ACCOUNT_ID and AUTO_ROUTING_URL (default https://auto-routing.kiloapps.io).'
    );
    return;
  }
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error('--limit must be an integer between 1 and 10000');
  }
  const resume = parseResume(values.resume);
  if (values.apply && values['dry-run']) throw new Error('Choose --dry-run or --apply, not both');
  const dryRun = !values.apply;
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

  const { clean, completed, error } = await runOwnerPoolConversion({
    objectIds,
    resume,
    dryRun,
    log: line => console.log(line),
    scan: async ({ ownerType, after, consecutiveFailed }) => {
      const response = await fetch(target, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ownerType, objectIds, after, limit, dryRun, consecutiveFailed }),
        signal: AbortSignal.timeout(300_000),
        redirect: 'error',
      });
      return { status: response.status, body: await response.json() };
    },
  });
  if (error) console.error(error.message);
  if (!clean) {
    console.error(
      completed
        ? 'Some owners need attention; see readFailed, invalidPool, invalidMode, needsAttention, and unmatched.'
        : 'The run did not complete (completed: false). Handle the needsAttention owners listed so far, then resume as printed above; notPosted owners need no action, the resume posts them.'
    );
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Owner pool conversion failed');
  process.exitCode = 1;
});
