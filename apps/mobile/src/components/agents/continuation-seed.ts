import { type Part, type StoredMessage, type TextPart } from '@kilocode/cloud-agent-sdk';
import { normalizeAgentMode } from '@/components/agents/mode-options';
import {
  buildContinuePrefillParams,
  type NewSessionPrefill,
  resolvePrefillModel,
  resolvePrefillRepo,
} from '@/components/agents/new-session-prefill';
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
 * Validate a stored model against the current gateway catalog.
 *
 * Returns the original model + variant when present and valid. Returns empty
 * strings when the model is absent or the variant is not in its variant list,
 * so the caller can omit the model override and let the remote CLI use its
 * default.
 */
export function resolveContinueRemoteModel(
  model: string,
  variant: string,
  catalog: { id: string; variants: string[] }[]
): { model: string; variant: string } {
  const found = catalog.find(m => m.id === model);
  if (!found) {
    return { model: '', variant: '' };
  }
  if (variant && !found.variants.includes(variant)) {
    return { model: '', variant: '' };
  }
  return { model, variant };
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
