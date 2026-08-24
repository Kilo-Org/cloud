import { getEnvVariable } from '@/lib/dotenvx';
import {
  classifyResponse,
  configurationMissing,
  continueIfLowTime,
  deletionFetch,
  isRecord,
  readJsonUnknown,
  requireTargetEmail,
  type DeletionHandler,
} from '@/lib/user/deletion-queue/handlers/common';

export const handleCsaSupportDb: DeletionHandler = async ({ request, context }) => {
  const stop = continueIfLowTime(context);
  if (stop) return stop;

  const emailOrOutcome = requireTargetEmail(request);
  if (typeof emailOrOutcome !== 'string') return emailOrOutcome;

  const secret = getEnvVariable('SUPPORT_API_SECRET').trim();
  if (!secret) return configurationMissing();

  const baseUrl = getEnvVariable('CSA_APP_BASE_URL').trim().replace(/\/$/, '');
  if (!baseUrl) {
    return { kind: 'retry', errorCode: 'csa_base_url_missing', httpStatusClass: 'error' };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Request-Id': request.id,
  };
  const actorEmail = request.requested_by_email?.trim();
  if (actorEmail) headers['X-Actor-Email'] = actorEmail;
  const protectionBypass = getEnvVariable('CSA_VERCEL_PROTECTION_BYPASS').trim();
  if (protectionBypass) headers['x-vercel-protection-bypass'] = protectionBypass;

  const result = await deletionFetch(context, `${baseUrl}/api/internal/cloud/users/gdpr-scrub`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: emailOrOutcome, requestId: request.id }),
  });
  if ('outcome' in result) return result.outcome;

  if (result.response.status === 401 || result.response.status === 403) {
    return { kind: 'needs_attention', errorCode: 'csa_unauthorized' };
  }
  if (result.response.status === 400) {
    return { kind: 'needs_attention', errorCode: 'csa_blocked_email' };
  }
  if (!result.response.ok) return classifyResponse(result.response);

  const payload = await readJsonUnknown(result.response);
  const status = isRecord(payload) && typeof payload.status === 'string' ? payload.status : null;
  if (status === 'updated') return { kind: 'succeeded' };
  if (status === 'not_found') return { kind: 'not_applicable' };
  return { kind: 'needs_attention', errorCode: 'csa_response_unparsed' };
};
