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

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function sqlDateTime(ms: number): string {
  return `toDateTime(${Math.floor(ms / 1000)})`;
}
