import { AutoRoutingInputGuardrailRequestSchema } from '@kilocode/auto-routing-contracts';
import { after } from 'next/server';
import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { admitEnkryptGuardrail } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/admission';
import { startEnkryptInputGuardrail } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/input-guardrail';
import { extractRequestParts } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';
import { enkryptGuardrailRejectionResponse } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/responses';
import type { OpenRouterChatCompletionRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getOrganizationGroupPolicyContext } from '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server';
import { getBalanceForOrganizationUser } from '@kilocode/web-shared/lib/organizations/organization-usage';

// Only the authenticated routing Worker supplies the payer and member. A decide is not itself an
// inference usage row: the guardrail accounts its own scans without a microdollar usage id.
export async function handleAutoRoutingInputGuardrailRequest(request: Request): Promise<Response> {
  const token = extractBearerToken(request.headers.get('authorization'));
  if (!INTERNAL_API_SECRET || !token || !timingSafeEqual(token, INTERNAL_API_SECRET)) {
    return new Response(null, { status: 401 });
  }
  const parsed = AutoRoutingInputGuardrailRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) return new Response(null, { status: 400 });
  const { userId, organizationId, sessionId, clientRequestId, ...body } = parsed.data;
  const account = await getBalanceForOrganizationUser(organizationId, userId, { fromDb: readDb });
  if (!account.payer || account.balance <= 0) return new Response(null, { status: 402 });
  const admission = await admitEnkryptGuardrail(
    { kind: 'signed-in', user: { id: userId }, organizationId },
    account,
    async () => {
      const context = await getOrganizationGroupPolicyContext({
        organizationId,
        subject: { type: 'member', kiloUserId: userId },
        fromDb: readDb,
      });
      return context.groups.map(group => group.id);
    }
  );
  if (admission.kind === 'rejected') return admission.response;
  const guardrail = startEnkryptInputGuardrail(
    Promise.resolve(admission.inputGuardrail).then(
      scope =>
        scope && {
          ...scope,
          sessionId,
          clientRequestId: clientRequestId ?? null,
          apiKind: 'chat_completions',
          // As on chat/completions, unexpected content shapes fail inside the guarded extraction.
          parts: extractRequestParts({
            kind: 'chat_completions',
            body: body as OpenRouterChatCompletionRequest,
          }),
        }
    ),
    request.signal
  );
  after(guardrail.requestLogs(false));
  return (
    enkryptGuardrailRejectionResponse('chat_completions', await guardrail.awaitVerdict()) ??
    new Response(null, { status: 204 })
  );
}
