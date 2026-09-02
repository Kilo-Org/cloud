import type { StoredMessage } from '@kilocode/cloud-agent-sdk';

const COST_RECONCILIATION_EPSILON_USD = 1e-6;
const MINIMUM_RENDERABLE_COST_MICRODOLLARS = 50;

export type SessionCostBreakdown = {
  totalCostUsd: number;
  rootCostUsd: number;
  subagentCostUsd: number;
  olderActivityCostUsd: number;
};

export function isRenderableSessionCost(costUsd: number): boolean {
  const costMicrodollars = Math.round(sanitizeNonNegativeCost(costUsd) * 1_000_000);
  return costMicrodollars >= MINIMUM_RENDERABLE_COST_MICRODOLLARS;
}

function getDisplayedSessionCostUnits(costUsd: number): number {
  const costMicrodollars = Math.round(sanitizeNonNegativeCost(costUsd) * 1_000_000);
  return Math.round(costMicrodollars / 100);
}

export function formatSessionCost(costUsd: number): string {
  return `$${(getDisplayedSessionCostUnits(costUsd) / 10_000).toFixed(4)}`;
}

export function getDisplayedSessionCostBreakdown(
  sessionCostBreakdown: SessionCostBreakdown
): SessionCostBreakdown {
  const totalUnits = getDisplayedSessionCostUnits(sessionCostBreakdown.totalCostUsd);
  const subagentUnits = Math.min(
    getDisplayedSessionCostUnits(sessionCostBreakdown.subagentCostUsd),
    totalUnits
  );
  const olderActivityUnits = Math.min(
    getDisplayedSessionCostUnits(sessionCostBreakdown.olderActivityCostUsd),
    totalUnits - subagentUnits
  );

  return {
    totalCostUsd: totalUnits / 10_000,
    rootCostUsd: (totalUnits - subagentUnits - olderActivityUnits) / 10_000,
    subagentCostUsd: subagentUnits / 10_000,
    olderActivityCostUsd: olderActivityUnits / 10_000,
  };
}

function sanitizeNonNegativeCost(cost: number | null | undefined): number {
  return cost != null && Number.isFinite(cost) && cost > 0 ? cost : 0;
}

export function getSessionTotalCostUsd(
  persistedTotalCostMicrodollars: number | null | undefined,
  liveTotalCostUsd: number
): number {
  const persistedCostMicrodollars = sanitizeNonNegativeCost(persistedTotalCostMicrodollars);
  const liveCostMicrodollars = Math.round(sanitizeNonNegativeCost(liveTotalCostUsd) * 1_000_000);

  return Math.max(persistedCostMicrodollars, liveCostMicrodollars) / 1_000_000;
}

export function getSessionCostBreakdown(
  messages: ReadonlyArray<StoredMessage>,
  persistedTotalCostMicrodollars: number | null | undefined,
  liveTotalCostUsd: number
): SessionCostBreakdown {
  const persistedCostMicrodollars = sanitizeNonNegativeCost(persistedTotalCostMicrodollars);
  const liveCostUsd = sanitizeNonNegativeCost(liveTotalCostUsd);
  const liveCostMicrodollars = Math.round(liveCostUsd * 1_000_000);
  let rootCostUsd = 0;

  for (const message of messages) {
    if (message.info.role !== 'assistant') {
      continue;
    }

    let hasStepFinishPart = false;
    let hasTaskToolPart = false;

    for (const part of message.parts) {
      if (part.type === 'step-finish' && Number.isFinite(part.cost) && part.cost >= 0) {
        hasStepFinishPart = true;
        rootCostUsd += part.cost;
      }

      if (part.type === 'tool' && part.tool === 'task') {
        hasTaskToolPart = true;
      }
    }

    if (!hasStepFinishPart && !hasTaskToolPart) {
      rootCostUsd += sanitizeNonNegativeCost(message.info.cost);
    }
  }

  const subagentResidualUsd = liveCostUsd - rootCostUsd;
  const olderActivityResidualUsd = (persistedCostMicrodollars - liveCostMicrodollars) / 1_000_000;

  return {
    totalCostUsd: getSessionTotalCostUsd(persistedCostMicrodollars, liveCostUsd),
    rootCostUsd,
    subagentCostUsd:
      subagentResidualUsd > COST_RECONCILIATION_EPSILON_USD ? subagentResidualUsd : 0,
    olderActivityCostUsd: isRenderableSessionCost(olderActivityResidualUsd)
      ? olderActivityResidualUsd
      : 0,
  };
}
