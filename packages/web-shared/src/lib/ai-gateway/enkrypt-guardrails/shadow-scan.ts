import { canSpendPaidUsage } from '@kilocode/worker-utils/account-access';
import type { OrganizationSettings } from '@kilocode/web-shared/lib/organizations/organization-types';
import { isEnkryptShadowGuardrailsEnabled } from '@kilocode/web-shared/lib/organizations/enkrypt-shadow-guardrails';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { MicrodollarUsageStats } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  callEnkryptDetect,
  truncateForScan,
  type ScanDirection,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrails/enkrypt-detect';
import {
  extractTurnInputText,
  joinScanTexts,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrails/turn-text';
import {
  computeEnkryptScanCharge,
  recordEnkryptGuardrailScan,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrails/scan-ledger';
import { errorExceptInTest, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

export function shouldRunEnkryptShadowScan(params: {
  apiKey: string | undefined;
  organizationId: string | undefined;
  settings: OrganizationSettings | undefined;
  balance: number;
  responseStatus: number;
}): boolean {
  return (
    !!params.apiKey &&
    params.responseStatus < 400 &&
    isEnkryptShadowGuardrailsEnabled(params.organizationId, params.settings) &&
    canSpendPaidUsage(params.balance)
  );
}

export type EnkryptShadowScanParams = {
  apiKey: string;
  organizationId: string;
  kiloUserId: string;
  requestId: string;
  apiKind: GatewayRequest['kind'];
  model: string;
  requestBodyText: string;
  usageStats: Promise<MicrodollarUsageStats | null>;
  usageId: Promise<string | null>;
  fetchImpl?: typeof fetch;
};

function inputTextOf(apiKind: GatewayRequest['kind'], requestBodyText: string): string {
  try {
    return extractTurnInputText(apiKind, JSON.parse(requestBodyText));
  } catch {
    return '';
  }
}

async function scanDirection(
  params: EnkryptShadowScanParams,
  direction: ScanDirection,
  fullText: string,
  usageId: string | null
): Promise<void> {
  if (!fullText) return;
  try {
    const { text, truncated } = truncateForScan(fullText);
    const outcome = await callEnkryptDetect({
      apiKey: params.apiKey,
      direction,
      text,
      userMetadata: {
        request_id: params.requestId,
        organization_id: params.organizationId,
        ...(usageId ? { usage_id: usageId } : {}),
        direction,
      },
      fetchImpl: params.fetchImpl,
    });
    const charge = computeEnkryptScanCharge(outcome, direction, text.length);
    if (outcome.error) {
      warnExceptInTest('Enkrypt shadow guardrail scan failed', {
        direction,
        error: outcome.error,
        request_id: params.requestId,
      });
    }
    await recordEnkryptGuardrailScan({
      organization_id: params.organizationId,
      kilo_user_id: params.kiloUserId,
      request_id: params.requestId,
      usage_id: usageId,
      api_kind: params.apiKind,
      model: params.model,
      direction,
      text_chars: text.length,
      truncated,
      flagged: outcome.flagged,
      summary: outcome.summary,
      http_status: outcome.httpStatus,
      error: outcome.error,
      enkrypt_credits: charge.enkryptCredits,
      enkrypt_credits_estimated: charge.estimated,
      enkrypt_latency_ms: outcome.latencyMs,
      cost_microdollars: charge.costMicrodollars,
    });
  } catch (error) {
    errorExceptInTest('Failed to record Enkrypt shadow guardrail scan', {
      direction,
      request_id: params.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Scans the new input of a turn and the assistant output after the response has
 * been delivered. Never rejects: every failure is logged or recorded as a row.
 */
export async function runEnkryptShadowScan(params: EnkryptShadowScanParams): Promise<void> {
  try {
    const [usageStats, usageId] = await Promise.all([
      params.usageStats.catch(() => null),
      params.usageId.catch(() => null),
    ]);
    const inputText = inputTextOf(params.apiKind, params.requestBodyText);
    const outputText = usageStats
      ? joinScanTexts([usageStats.responseContent, usageStats.toolCallArguments])
      : '';
    await Promise.all([
      scanDirection(params, 'input', inputText, usageId),
      scanDirection(params, 'output', outputText, usageId),
    ]);
  } catch (error) {
    errorExceptInTest('Enkrypt shadow guardrail scan crashed', {
      request_id: params.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
