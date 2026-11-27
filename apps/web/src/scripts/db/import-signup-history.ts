/**
 * Operator script that imports completed signup history into Bouncer's signup-history route.
 *
 * It authenticates with the shared `INTERNAL_API_SECRET` (`x-internal-api-key`), and that
 * legacy-key path stops working once Bouncer runs `STS_AUTH=sts`. From then on the only route is
 * the `ci-bouncer-signup-import` GitHub OIDC workflow (owner: kc-ci-sts), which calls Bouncer with
 * an STS token for `bouncer:signup.history`. Until then an operator must pass
 * `--bouncer-legacy-auth`, confirming Bouncer still runs `STS_AUTH` `legacy` or `dual`; without it
 * the script refuses before reading the database or sending any request.
 *
 * Usage: `pnpm --filter web script:run db import-signup-history --bouncer-legacy-auth [since]`.
 */
import { kilocode_users } from '@kilocode/db/schema';
import { signupOperationId } from '@kilocode/web-shared/lib/bouncer/signup';
import { bareIpLiteral } from '@kilocode/web-shared/lib/bouncer/inference';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { normalizeEmail } from '@kilocode/web-shared/lib/email-address';
import { and, asc, eq, gt, gte, isNotNull, lte, ne, or } from 'drizzle-orm';
import * as z from 'zod';

const PAGE_SIZE = 100;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const IMPORT_TIMEOUT_MS = 30_000;
const startTimestamp = z.iso.datetime({ offset: true });
const importResponse = z.strictObject({ imported: z.number().int().min(0).max(PAGE_SIZE) });

type SignupHistoryCursor = {
  createdAt: string;
  id: string;
};

type SignupHistoryRow = SignupHistoryCursor & {
  ip: string | null;
  normalizedEmail: string | null;
  email: string;
};

type SignupHistoryEntry = {
  operationId: string;
  ip: string;
  occurredAt: string;
};

export const LEGACY_AUTH_FLAG = '--bouncer-legacy-auth';

export const LEGACY_AUTH_REQUIRED =
  `import-signup-history sends Bouncer the legacy INTERNAL_API_SECRET (x-internal-api-key), which ` +
  `stops working once Bouncer runs STS_AUTH=sts; from then on the route is the ` +
  `ci-bouncer-signup-import GitHub OIDC workflow (owner: kc-ci-sts). Pass ${LEGACY_AUTH_FLAG} ` +
  `only while Bouncer still runs STS_AUTH legacy or dual.`;

/** Imports completed signup history without changing Cloud users or enforcement switches. */
export async function run(...args: string[]): Promise<void> {
  // Preflight: refuse before reading the environment, the database or calling Bouncer.
  if (!args.includes(LEGACY_AUTH_FLAG)) throw new Error(LEGACY_AUTH_REQUIRED);
  const positional = args.filter(arg => arg !== LEGACY_AUTH_FLAG);
  if (positional.length > 1) throw new Error('Pass at most one start timestamp');
  const since = positional[0];
  const baseUrl = getEnvVariable('BOUNCER_URL');
  const key = getEnvVariable('INTERNAL_API_SECRET');
  if (!baseUrl || !key) throw new Error('BOUNCER_URL and INTERNAL_API_SECRET must be configured');
  // The shared Drizzle client can otherwise print query parameters to the runner's output.
  if (process.env.DEBUG_QUERY_LOGGING) {
    throw new Error('Disable DEBUG_QUERY_LOGGING before importing signup history');
  }
  let target: URL;
  try {
    target = new URL('/api/v1/signup-history', baseUrl);
  } catch {
    throw new Error('BOUNCER_URL must be a valid absolute URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) {
    throw new Error('The history target must use HTTPS, except HTTP on loopback');
  }
  if (target.username || target.password) {
    throw new Error('BOUNCER_URL must not contain credentials');
  }

  const snapshot = new Date();
  const retainedSince = snapshot.getTime() - RETENTION_MS;
  if (since !== undefined && !startTimestamp.safeParse(since).success) {
    throw new Error('The optional start timestamp must be ISO 8601 with a timezone');
  }
  const start = since === undefined ? retainedSince : Date.parse(since);
  if (!Number.isFinite(start) || start < retainedSince || start > snapshot.getTime()) {
    throw new Error(
      'The optional start timestamp must be within the last 30 days and not in the future'
    );
  }
  const startIso = new Date(start).toISOString();
  const snapshotIso = snapshot.toISOString();
  let cursor: SignupHistoryCursor | undefined;
  let imported = 0;

  console.log('Signup history import started', {
    since: startIso,
    through: snapshotIso,
    pageSize: PAGE_SIZE,
  });
  for (;;) {
    let rows: SignupHistoryRow[];
    try {
      rows = await db
        .select({
          id: kilocode_users.id,
          createdAt: kilocode_users.created_at,
          ip: kilocode_users.signup_ip,
          normalizedEmail: kilocode_users.normalized_email,
          email: kilocode_users.google_user_email,
        })
        .from(kilocode_users)
        .where(
          and(
            gte(kilocode_users.created_at, startIso),
            lte(kilocode_users.created_at, snapshotIso),
            isNotNull(kilocode_users.signup_ip),
            ne(kilocode_users.signup_ip, ''),
            cursor === undefined
              ? undefined
              : or(
                  gt(kilocode_users.created_at, cursor.createdAt),
                  and(
                    eq(kilocode_users.created_at, cursor.createdAt),
                    gt(kilocode_users.id, cursor.id)
                  )
                )
          )
        )
        .orderBy(asc(kilocode_users.created_at), asc(kilocode_users.id))
        .limit(PAGE_SIZE);
    } catch {
      throw new Error(`Signup history database page failed; imported ${imported} entries`);
    }
    if (rows.length === 0) break;

    // Validate the entire page before sending any of it; invalid nonempty IPs are not exclusions.
    const entries: SignupHistoryEntry[] = rows.map(row => {
      const ip = bareIpLiteral(row.ip ?? undefined);
      if (!ip) {
        throw new Error(
          `A history page contains an invalid signup IP; imported ${imported} entries`
        );
      }
      return {
        operationId: signupOperationId(normalizeEmail(row.normalizedEmail || row.email)),
        ip,
        occurredAt: new Date(row.createdAt).toISOString(),
      };
    });
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': key,
          // Bouncer counts legacy calls per caller; this is the name its KNOWN_CALLERS gives the job.
          'x-kilo-caller': 'ci-bouncer-signup-import',
        },
        body: JSON.stringify({ entries }),
        redirect: 'error',
        signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
      });
    } catch {
      throw new Error(
        `Signup history page request failed or timed out; imported ${imported} entries`
      );
    }
    if (!response.ok) {
      throw new Error(
        `Signup history import failed with HTTP ${response.status}; imported ${imported} entries`
      );
    }
    let body: unknown;
    try {
      // The fetch abort signal also bounds response-body consumption to the page request budget.
      body = await response.json();
    } catch {
      throw new Error(
        `Signup history response was invalid or timed out; imported ${imported} entries`
      );
    }
    const result = importResponse.safeParse(body);
    if (!result.success) {
      throw new Error(`Signup history response has an invalid shape; imported ${imported} entries`);
    }
    if (result.data.imported !== entries.length) {
      throw new Error(
        `Signup history import acknowledged an incomplete page; imported ${imported} entries`
      );
    }
    imported += result.data.imported;
    const last = rows.at(-1);
    if (last === undefined) {
      throw new Error(`Signup history page lost its cursor; imported ${imported} entries`);
    }
    // Preserve the database timestamp's full precision for keyset pagination.
    cursor = { createdAt: last.createdAt, id: last.id };
    console.log('Signup history page acknowledged', { imported });
  }
  console.log('Signup history import complete', {
    imported,
    since: startIso,
    through: snapshotIso,
    missingIp: 'excluded, matching the previous Cloud limiter',
  });
}
