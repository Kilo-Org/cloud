import 'server-only';

import * as z from 'zod';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

export type RunAnalyticsEngineQuery = <Row>(
  sql: string,
  rowSchema: z.ZodType<Row>
) => Promise<Row[]>;

const ResponseEnvelopeSchema = z.object({ data: z.array(z.unknown()) });

export async function queryAnalyticsEngine<Row>(
  sql: string,
  rowSchema: z.ZodType<Row>,
  { timeoutMs }: { timeoutMs: number }
): Promise<Row[]> {
  const accountId = getEnvVariable('R2_ACCOUNT_ID');
  const token = getEnvVariable('CF_ANALYTICS_ENGINE_TOKEN');
  if (!accountId || !token) {
    throw new Error('Missing Cloudflare Analytics Engine configuration');
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: sql,
      signal: AbortSignal.timeout(timeoutMs),
    }
  );

  if (!response.ok) {
    throw new Error(`Analytics Engine query failed (${response.status}): ${await response.text()}`);
  }

  const { data } = ResponseEnvelopeSchema.parse(await response.json());
  return z.array(rowSchema).parse(data);
}

const LAST_CONTROL_CODE_POINT = 0x1f;
const DELETE_CODE_POINT = 0x7f;

/**
 * Analytics Engine SQL follows ClickHouse literal syntax, where a backslash
 * starts an escape sequence (`\\` is one backslash, `\'` a quote, `\xHH` a byte).
 * Backslashes are doubled so one cannot escape the quote that follows it,
 * quotes are doubled, and control characters become `\xHH` so the literal stays
 * on one line of printable text.
 */
function encodeLiteralCharacter(character: string): string {
  if (character === '\\') return '\\\\';
  if (character === "'") return "''";
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint <= LAST_CONTROL_CODE_POINT || codePoint === DELETE_CODE_POINT) {
    return `\\x${codePoint.toString(16).padStart(2, '0')}`;
  }
  return character;
}

/** Renders `value` as a single-quoted SQL string literal that reads back as `value`. */
export function sqlString(value: string): string {
  let literal = "'";
  for (const character of value) {
    literal += encodeLiteralCharacter(character);
  }
  return `${literal}'`;
}

export function sqlDateTime(ms: number): string {
  return `toDateTime(${Math.floor(ms / 1000)})`;
}
