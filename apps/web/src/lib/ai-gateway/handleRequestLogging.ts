import { api_request_log, type User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { logExceptInTest } from '@/lib/utils.server';
import { after } from 'next/server';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { kilologHash } from '@/lib/ai-gateway/kilologHash';
import { createHash } from 'crypto';
import { redisSet } from '@/lib/redis';

const users = [
  '992891e9fe987b8960a05ed0bc9cc456979d1d71410d467f212e6233dbc0a523', // christiaan
  'a8cd59cc6df67645c2f509948ee9a579582a7593db43fbad9bcf37cce38f2d87', // https://kilo-code.slack.com/archives/C09H2GDAJ75/p1776149178143169
];

const organizations = [
  '3f48333c176a29aaeeb25f3475e38511fc7184b34321a1605a3c0db54cae6df4', // kilo
];

async function isLoggingEnabledForUser(
  user: User | null,
  organizationId: string | null
): Promise<boolean> {
  if (user?.google_user_email.endsWith('@kilo.ai')) return true;
  if (user?.google_user_email.endsWith('@kilocode.ai')) return true;
  if (user?.id && users.includes(await kilologHash(user.id))) return true;
  if (organizationId && organizations.includes(await kilologHash(organizationId))) return true;
  return false;
}

export async function handleRequestLogging(params: {
  clonedResponse: Response;
  user: User | null;
  organization_id: string | null;
  provider: string;
  model: string;
  request: GatewayRequest;
}) {
  const { clonedResponse, user, organization_id, provider, model, request } = params;
  if (!(await isLoggingEnabledForUser(user, organization_id))) {
    return;
  }
  after(async () => {
    let response: string | undefined;
    try {
      response = await clonedResponse.text();
      const apiRequestLogId = await db
        .insert(api_request_log)
        .values({
          kilo_user_id: user?.id,
          organization_id: organization_id,
          status_code: clonedResponse.status,
          model,
          provider,
          request: request.body,
          response,
        })
        .returning({ id: api_request_log.id });
      logExceptInTest(
        '[handleRequestLogging] Inserted into api_request_log',
        apiRequestLogId[0].id
      );
    } catch (e) {
      logExceptInTest(
        `[handleRequestLogging] failed to insert api_request_log (user=${user?.id}, status=${clonedResponse.status}, model=${model})`
      );
      try {
        logExceptInTest(
          '[handleRequestLogging] error (truncated): ' + String(e).substring(0, 4000)
        );
      } catch {
        //ignore
      }
      try {
        const serialized = JSON.stringify(request.body);
        const hash = createHash('sha256').update(serialized).digest('hex');
        await redisSet(`ai-gateway.request-log:${hash}`, serialized, 604800);
        logExceptInTest('[handleRequestLogging] request hash: ' + hash);
      } catch {
        //ignore
      }
      try {
        logExceptInTest(
          '[handleRequestLogging] response (truncated): ' + response?.substring(0, 4000)
        );
      } catch {
        //ignore
      }
    }
  });
}
