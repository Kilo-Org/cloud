import { getEnvVariable } from '@/lib/dotenvx';
import { USER_DELETION_CUSTOMERIO_TRACK_BASE } from '@/lib/user/deletion-queue/deletion-constants';
import type { DeletionHandler } from '@/lib/user/deletion-queue/handlers/common';
import {
  classifyResponse,
  configurationMissing,
  continueIfLowTime,
  deletionFetch,
  requireTargetEmail,
} from '@/lib/user/deletion-queue/handlers/common';

export function customerioTrackBase(): string {
  const configured = getEnvVariable('CUSTOMERIO_TRACK_BASE').trim().replace(/\/$/, '');
  return configured || USER_DELETION_CUSTOMERIO_TRACK_BASE;
}

export const handleCustomerio: DeletionHandler = async ({ request, context }) => {
  const stop = continueIfLowTime(context);
  if (stop) return stop;

  const emailOrOutcome = requireTargetEmail(request);
  if (typeof emailOrOutcome !== 'string') return emailOrOutcome;

  const siteId = getEnvVariable('CUSTOMERIO_SITE_ID').trim();
  const apiKey = getEnvVariable('CUSTOMERIO_API_KEY').trim();
  if (!siteId || !apiKey) return configurationMissing();

  const url = `${customerioTrackBase()}/api/v1/customers/${encodeURIComponent(emailOrOutcome)}`;
  const result = await deletionFetch(context, url, {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${Buffer.from(`${siteId}:${apiKey}`).toString('base64')}`,
    },
  });
  if ('outcome' in result) return result.outcome;

  if (result.response.ok) {
    return { kind: 'succeeded' };
  }
  if (result.response.status === 404) {
    return { kind: 'not_applicable' };
  }
  return classifyResponse(result.response);
};
