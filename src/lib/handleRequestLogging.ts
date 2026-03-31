import { api_request_log, type User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { logExceptInTest } from '@/lib/utils.server';
import { after } from 'next/server';
import type { GatewayRequest } from '@/lib/providers/openrouter/types';
import { createHash } from 'node:crypto';

const users = [
  '992891e9fe987b8960a05ed0bc9cc456979d1d71410d467f212e6233dbc0a523', // christiaan
];

const organizations = [
  '3f48333c176a29aaeeb25f3475e38511fc7184b34321a1605a3c0db54cae6df4', // kilo
];

function hash(str: string) {
  return createHash('sha256')
    .update('kilolog|' + str)
    .digest('hex');
}

function isLoggingEnabledForUser(user: User | null, organizationId: string | null): boolean {
  return (
    user?.google_user_email.endsWith('@kilo.ai') ||
    user?.google_user_email.endsWith('@kilocode.ai') ||
    (!!user?.id && users.includes(hash(user.id))) ||
    (!!organizationId && organizations.includes(hash(organizationId)))
  );
}

export function handleRequestLogging(params: {
  clonedResponse: Response;
  user: User | null;
  organization_id: string | null;
  provider: string;
  model: string;
  request: GatewayRequest;
}) {
  const { clonedResponse, user, organization_id, provider, model, request } = params;
  if (!isLoggingEnabledForUser(user, organization_id)) {
    return;
  }
  after(async () => {
    try {
      const apiRequestLogId = await db
        .insert(api_request_log)
        .values({
          kilo_user_id: user?.id,
          organization_id: organization_id,
          status_code: clonedResponse.status,
          model,
          provider,
          request: request.body,
          response: await clonedResponse.text(),
        })
        .returning({ id: api_request_log.id });
      logExceptInTest(
        '[handleRequestLogging] Inserted into api_request_log',
        apiRequestLogId[0].id
      );
    } catch (e) {
      logExceptInTest('[handleRequestLogging] Failed to insert api_request_log', e);
    }
  });
}
