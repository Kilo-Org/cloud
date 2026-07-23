import { getStepFinishRoutedModel, type RoutedModelRef } from 'cloud-agent-sdk/part-utils';
import {
  type AssistantMessage,
  type Part,
  type StepFinishPart,
  type StoredMessage,
} from 'cloud-agent-sdk';

export type SessionCostBreakdownTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cacheRatePct: number | null;
};

export type SessionCostBreakdownModel = {
  providerID: string;
  modelID: string;
  steps: number;
  costUsd: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type SessionCostBreakdown = {
  totals: SessionCostBreakdownTotals;
  models: SessionCostBreakdownModel[];
  attributedCostUsd: number;
  subagentCostUsd: number;
};

type Step = {
  providerID: string;
  modelID: string;
  costUsd: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

// One micro-dollar — below the sheet's 4-decimal display precision.
const COST_RECONCILIATION_EPSILON_USD = 1e-6;

/**
 * Aggregate a session's cost + token usage by model, with a subagent
 * residual so the per-model rows reconcile to the session total.
 *
 * Sums step-finish parts (preferred) plus a single info-level fallback per
 * assistant message that had no step-finish parts. The model key for each
 * step is the routed model stamped by the CLI on the part, falling back to
 * the message's own providerID/modelID.
 *
 * The session's `totalCostUsd` is the source of truth: we never recompute it.
 * The subagent residual is the delta between the session total and the sum
 * of per-step costs (subagent cost is folded into the parent message but
 * never appears on a step-finish part). Token totals are this-session-only.
 */
export function getSessionCostBreakdown(
  messages: StoredMessage[],
  totalCostUsd: number
): SessionCostBreakdown {
  const steps: Step[] = [];

  for (const message of messages) {
    if (message.info.role === 'assistant') {
      const stepFinishParts = collectStepFinishParts(message.parts);
      if (stepFinishParts.length > 0) {
        for (const part of stepFinishParts) {
          steps.push(stepFromStepFinish(message.info, part));
        }
      } else {
        steps.push(stepFromAssistantInfo(message.info));
      }
    }
  }

  const grouped = new Map<string, SessionCostBreakdownModel>();
  for (const step of steps) {
    const key = `${step.providerID}:${step.modelID}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.steps += 1;
      existing.costUsd += step.costUsd;
      existing.tokens.input += step.tokens.input;
      existing.tokens.output += step.tokens.output;
      existing.tokens.reasoning += step.tokens.reasoning;
      existing.tokens.cacheRead += step.tokens.cacheRead;
      existing.tokens.cacheWrite += step.tokens.cacheWrite;
      existing.tokens.total =
        existing.tokens.input +
        existing.tokens.output +
        existing.tokens.reasoning +
        existing.tokens.cacheRead +
        existing.tokens.cacheWrite;
    } else {
      grouped.set(key, {
        providerID: step.providerID,
        modelID: step.modelID,
        steps: 1,
        costUsd: step.costUsd,
        tokens: {
          input: step.tokens.input,
          output: step.tokens.output,
          reasoning: step.tokens.reasoning,
          cacheRead: step.tokens.cacheRead,
          cacheWrite: step.tokens.cacheWrite,
          total:
            step.tokens.input +
            step.tokens.output +
            step.tokens.reasoning +
            step.tokens.cacheRead +
            step.tokens.cacheWrite,
        },
      });
    }
  }

  const models = [...grouped.values()];

  let totalsInput = 0;
  let totalsOutput = 0;
  let totalsReasoning = 0;
  let totalsCacheRead = 0;
  let totalsCacheWrite = 0;
  for (const model of models) {
    totalsInput += model.tokens.input;
    totalsOutput += model.tokens.output;
    totalsReasoning += model.tokens.reasoning;
    totalsCacheRead += model.tokens.cacheRead;
    totalsCacheWrite += model.tokens.cacheWrite;
  }

  const cacheDenominator = totalsInput + totalsCacheRead + totalsCacheWrite;
  const cacheRatePct = cacheDenominator > 0 ? (totalsCacheRead / cacheDenominator) * 100 : null;

  const totals: SessionCostBreakdownTotals = {
    input: totalsInput,
    output: totalsOutput,
    reasoning: totalsReasoning,
    cacheRead: totalsCacheRead,
    cacheWrite: totalsCacheWrite,
    total: totalsInput + totalsOutput + totalsReasoning + totalsCacheRead + totalsCacheWrite,
    cacheRatePct,
  };

  const attributedCostUsd = models.reduce((sum, m) => sum + m.costUsd, 0);
  // `totalCostUsd` is authoritative and >= `attributedCostUsd` by the cost-propagation
  // model. A residual within +/-epsilon is floating-point noise, so no "Subagents" row
  // is emitted. A genuinely negative residual (should not occur) is treated as zero
  // rather than surfaced as a negative cost. This makes the clamp a deliberate,
  // documented reconciliation step, not a silent guard.
  const costResidualUsd = totalCostUsd - attributedCostUsd;
  const subagentCostUsd = costResidualUsd > COST_RECONCILIATION_EPSILON_USD ? costResidualUsd : 0;

  return { totals, models, attributedCostUsd, subagentCostUsd };
}

function collectStepFinishParts(parts: Part[]): StepFinishPart[] {
  const out: StepFinishPart[] = [];
  for (const part of parts) {
    if (part.type === 'step-finish') {
      out.push(part);
    }
  }
  return out;
}

function stepFromStepFinish(info: AssistantMessage, part: StepFinishPart): Step {
  const routed: RoutedModelRef | undefined = getStepFinishRoutedModel(part);
  return {
    providerID: routed?.providerID ?? info.providerID,
    modelID: routed?.modelID ?? info.modelID,
    costUsd: part.cost,
    tokens: {
      input: part.tokens.input,
      output: part.tokens.output,
      reasoning: part.tokens.reasoning,
      cacheRead: part.tokens.cache.read,
      cacheWrite: part.tokens.cache.write,
    },
  };
}

function stepFromAssistantInfo(info: AssistantMessage): Step {
  return {
    providerID: info.providerID,
    modelID: info.modelID,
    costUsd: info.cost,
    tokens: {
      input: info.tokens.input,
      output: info.tokens.output,
      reasoning: info.tokens.reasoning,
      cacheRead: info.tokens.cache.read,
      cacheWrite: info.tokens.cache.write,
    },
  };
}
