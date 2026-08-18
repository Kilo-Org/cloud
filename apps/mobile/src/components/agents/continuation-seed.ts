import {
  type ModelSelection,
  type Part,
  type StoredMessage,
  type TextPart,
} from '@kilocode/cloud-agent-sdk';
import {
  type InstanceModelCatalogResult,
  type RemoteModelCatalogV1,
} from '@kilocode/cloud-agent-sdk/instance-model-catalog';
import { normalizeAgentMode } from '@/components/agents/mode-normalize';
import {
  buildContinuePrefillParams,
  type NewSessionPrefill,
  resolvePrefillModel,
  resolvePrefillRepo,
} from '@/components/agents/new-session-prefill';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import {
  buildCreateRemoteSessionInput,
  type CreateRemoteSessionInput,
} from '@/lib/hooks/remote-instance-spawn-classifier';
import { type InstancePickerInstance } from '@/lib/picker-bridge';

export const CONTINUATION_SEED_MAX_CHARS = 3800;

const SEED_PREAMBLE = `You are continuing a conversation that the user had with you in a previous session. The transcript of that conversation is below. Treat it as your own memory: the "User" turns are the user's messages and the "Assistant" turns are your own previous replies.

Reply with a short confirmation of the context you carried over (one or two sentences), then wait for the user's next instruction.`;

const SEED_OMISSION_MARKER = '[… middle of the transcript omitted for length …]';

type Turn = {
  label: 'User' | 'Assistant';
  text: string;
};

function isTextPart(part: Part): part is TextPart {
  return part.type === 'text';
}

function joinLen(parts: readonly string[]): number {
  return parts.reduce((sum, p) => sum + p.length, 0) + 2 * (parts.length - 1);
}

function serialize(t: Turn): string {
  return `${t.label}:\n${t.text}`;
}

export function buildContinuationSeed(messages: readonly StoredMessage[]): string | null {
  // Step 1: extract text turns from messages.
  const turns: Turn[] = [];
  for (const msg of messages) {
    const text = msg.parts
      .filter(part => isTextPart(part))
      .filter(part => part.synthetic !== true && part.ignored !== true)
      .map(part => part.text)
      .join('\n')
      .trim();

    if (text) {
      turns.push({
        label: msg.info.role === 'user' ? 'User' : 'Assistant',
        text,
      });
    }
  }

  // Step 2: no turns → null.
  if (turns.length === 0) {
    return null;
  }

  // Step 3: full transcript fits → return as-is.
  const full = turns.map(turn => serialize(turn)).join('\n\n');
  const seed = `${SEED_PREAMBLE}\n\n${full}`;
  if (seed.length <= CONTINUATION_SEED_MAX_CHARS) {
    return seed;
  }

  // Step 4: truncation branch.
  // The 2 accounts for '\n\n' after the preamble.
  const body = CONTINUATION_SEED_MAX_CHARS - SEED_PREAMBLE.length - 2;
  const firstTurn = turns[0];
  if (!firstTurn) {
    return null;
  }
  const head = serialize(firstTurn);

  // Greedily collect trailing turns newest-first.
  const midTurns = turns.slice(1);
  let tailParts: string[] = [];
  for (let i = midTurns.length - 1; i >= 0; i -= 1) {
    const turn = midTurns[i];
    if (!turn) {
      break;
    }
    const candidate = [serialize(turn), ...tailParts];
    const candidateLen =
      head.length +
      2 +
      SEED_OMISSION_MARKER.length +
      (candidate.length > 0 ? 2 + joinLen(candidate) : 0);
    if (candidateLen <= body) {
      tailParts = candidate;
    } else {
      break;
    }
  }

  const omitted = turns.length - 1 - tailParts.length;
  const tailStr = tailParts.length > 0 ? `\n\n${tailParts.join('\n\n')}` : '';
  let resultBody = omitted === 0 ? head + tailStr : `${head}\n\n${SEED_OMISSION_MARKER}${tailStr}`;

  // Safety guard: if head + marker alone exceeds body.
  if (resultBody.length > body) {
    resultBody = `${resultBody.slice(0, body - 1)}…`;
  }

  return `${SEED_PREAMBLE}\n\n${resultBody}`;
}

export type ContinuationDestination =
  | { kind: 'cloud-agent'; repo: string; model: string; variant: string }
  | { kind: 'remote'; instance: InstancePickerInstance };

/**
 * Resolve the stored model + variant of a continued session against the
 * target instance's model catalog.
 *
 * Returns a `ModelSelection` only when the selection is valid on the target:
 *
 * - The stored model must exist in `options`, the source session's picker
 *   options. A plain gateway option has no `modelRef`; its `id` is the
 *   gateway model id, so the selection defaults to the `kilo` provider.
 * - A non-empty variant must be offered by the source option; otherwise the
 *   whole selection is dropped, keeping today's "never silently change a
 *   variant" behavior.
 * - With a catalog, the provider and model must exist in it, and a set
 *   variant must be offered by that catalog model.
 * - Without a catalog (an old CLI, or a CLI whose catalog could not be
 *   read), only a `kilo` selection is sent; an unvalidated non-Kilo provider
 *   is omitted rather than guessed.
 *
 * Returns `undefined` when the selection must be omitted so the CLI uses its
 * own default model.
 */
export function resolveContinueRemoteSelection(input: {
  model: string;
  variant: string;
  options: SessionModelOption[];
  catalog: RemoteModelCatalogV1 | null;
}): ModelSelection | undefined {
  const { model, variant, options, catalog } = input;
  const option = options.find(o => o.id === model);
  if (!option) {
    return undefined;
  }
  if (variant && !option.variants.includes(variant)) {
    return undefined;
  }
  const ref = option.modelRef ?? { providerID: 'kilo', modelID: option.id };
  if (catalog !== null) {
    const catalogModel = catalog.providers
      .find(provider => provider.id === ref.providerID)
      ?.models.find(m => m.id === ref.modelID);
    if (!catalogModel || (variant && !catalogModel.variants.includes(variant))) {
      return undefined;
    }
  } else if (ref.providerID !== 'kilo') {
    return undefined;
  }
  return { model: ref, ...(variant ? { variant } : {}) };
}

/**
 * Assemble the `create_session` wire input for a continued remote session.
 *
 * Normalizes the catalog result with the same model-count rule as the
 * new-session hook: a parsed catalog counts only when it carries at least one
 * model; a catalog with no models is treated as "no catalog". Then resolves
 * the stored selection against it and delegates to
 * `buildCreateRemoteSessionInput`. Pure so the continue hook keeps no
 * catalog logic and the behavior is testable without mounting the hook.
 */
export function buildContinueRemoteSpawnInput(input: {
  mode: string;
  model: string;
  variant: string;
  options: SessionModelOption[];
  catalogResult: InstanceModelCatalogResult;
  organizationId: string | undefined;
}): CreateRemoteSessionInput | undefined {
  const catalog =
    input.catalogResult.ok &&
    input.catalogResult.catalog.providers.some(provider => provider.models.length > 0)
      ? input.catalogResult.catalog
      : null;
  const selection = resolveContinueRemoteSelection({
    model: input.model,
    variant: input.variant,
    options: input.options,
    catalog,
  });
  return buildCreateRemoteSessionInput({
    mode: input.mode,
    selection,
    organizationId: input.organizationId,
  });
}

export function resolveContinuationDestinations(args: {
  gitUrl: string | null | undefined;
  mode: string;
  model: string;
  variant: string;
  repositories: { fullName: string }[];
  models: { id: string; variants: string[] }[];
  instances: InstancePickerInstance[];
}): ContinuationDestination[] {
  const { gitUrl, mode, model, variant, repositories, models, instances } = args;

  const prefillParams = buildContinuePrefillParams({
    gitUrl,
    mode,
    model,
    variant,
  });
  const prefill: NewSessionPrefill = {
    mode: normalizeAgentMode(mode),
    ...(prefillParams.repo ? { repo: prefillParams.repo } : {}),
    ...(prefillParams.model ? { model: prefillParams.model } : {}),
    ...(prefillParams.variant ? { variant: prefillParams.variant } : {}),
  };

  const result: ContinuationDestination[] = [];

  // Cloud destination when both repo and model resolve.
  const repo = resolvePrefillRepo(repositories, prefill);
  const resolvedModel = resolvePrefillModel(models, prefill);
  if (repo !== null && resolvedModel !== null) {
    result.push({
      kind: 'cloud-agent',
      repo,
      model: resolvedModel.model,
      variant: resolvedModel.variant,
    });
  }

  // Remote destinations.
  for (const instance of instances) {
    result.push({ kind: 'remote', instance });
  }

  return result;
}
