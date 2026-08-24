import {
  asNonEmptyString,
  classifyResponse,
  continueIfLowTime,
  isRecord,
  type DeletionHandler,
} from '@/lib/user/deletion-queue/handlers/common';
import {
  addPylonIssueTag,
  normalizePylonTicket,
  pylonConfig,
  pylonData,
  pylonJson,
  pylonRequest,
} from '@/lib/user/deletion-queue/handlers/pylon-client';
import { USER_DELETION_PYLON_DELETE_COMPLETE_TAG } from '@/lib/user/deletion-queue/deletion-constants';

export const handlePylonFinalize: DeletionHandler = async ({ request, context }) => {
  if (!request.pylon_ticket_ref) {
    return { kind: 'not_applicable' };
  }

  const stop = continueIfLowTime(context);
  if (stop) return stop;

  const config = pylonConfig();
  if (!('apiKey' in config)) return config;

  const issueId = normalizePylonTicket(request.pylon_ticket_ref);
  if (!issueId) {
    return { kind: 'needs_attention', errorCode: 'pylon_ticket_invalid' };
  }

  const tagged = await addPylonIssueTag(
    context,
    config.apiKey,
    issueId,
    USER_DELETION_PYLON_DELETE_COMPLETE_TAG
  );
  if ('outcome' in tagged) return tagged.outcome;

  const close = await pylonRequest(
    context,
    config.apiKey,
    `/issues/${encodeURIComponent(issueId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    }
  );
  if ('outcome' in close) return close.outcome;
  if (!close.response.ok) {
    if (close.response.status === 429) return classifyResponse(close.response);
    return {
      kind: 'retry',
      errorCode: `http_${close.response.status}`,
      httpStatusClass: close.response.status >= 500 ? '5xx' : 'error',
    };
  }

  const json = await pylonJson(close.response);
  if ('outcome' in json) return json.outcome;
  const data = pylonData(json.payload);
  const state = isRecord(data) ? asNonEmptyString(data.state) : null;
  if (state !== 'closed') {
    return { kind: 'retry', errorCode: 'pylon_close_unconfirmed', httpStatusClass: 'error' };
  }
  return { kind: 'succeeded' };
};
