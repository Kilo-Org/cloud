import { verifyAutoDecision } from '@kilocode/auto-routing-contracts';
import type { ResolvedAutoModel } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { resolveCatalogVariant } from '@kilocode/web-shared/lib/ai-gateway/auto-model/resolution';

export type AutoDecisionRejection =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'user_mismatch'
  | 'organization_mismatch'
  | 'model_mismatch'
  | 'variant_unavailable';

export type AutoDecisionCheck =
  | { kind: 'ok'; routerModelId: string; resolved: ResolvedAutoModel }
  | { kind: 'rejected'; reason: AutoDecisionRejection };

// A CLI-path decision for a gateway pick (ADR 0005). The token binds the decision to one caller
// and one concrete model; the gateway serves the signed variant and attributes usage to the
// custom router.
export async function checkAutoDecision(params: {
  token: string;
  secret: string;
  nowMs: number;
  userId: string;
  organizationId: string | null;
  model: string;
}): Promise<AutoDecisionCheck> {
  const verification = await verifyAutoDecision(params.token, params.secret, params.nowMs);
  if (!verification.ok) return { kind: 'rejected', reason: verification.reason };
  const { payload } = verification;
  if (payload.userId !== params.userId) return { kind: 'rejected', reason: 'user_mismatch' };
  if (payload.organizationId !== params.organizationId) {
    return { kind: 'rejected', reason: 'organization_mismatch' };
  }
  if (payload.model.toLowerCase() !== params.model.toLowerCase()) {
    return { kind: 'rejected', reason: 'model_mismatch' };
  }
  const resolved = await resolveCatalogVariant(payload.model, payload.variant);
  if (!resolved) return { kind: 'rejected', reason: 'variant_unavailable' };
  return { kind: 'ok', routerModelId: payload.routerModelId, resolved };
}
