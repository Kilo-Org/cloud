import { type StoredMessage, type TextPart } from '@kilocode/cloud-agent-sdk';
import { normalizeAgentMode } from '@/components/agents/mode-options';
import {
  buildContinuePrefillParams,
  resolvePrefillModel,
  resolvePrefillRepo,
  type NewSessionPrefill,
} from '@/components/agents/new-session-prefill';
import { type InstancePickerInstance } from '@/lib/picker-bridge';

export const CONTINUATION_SEED_MAX_CHARS = 3800;

const SEED_PREAMBLE = `You are continuing a conversation that the user had with you in a previous session. The transcript of that conversation is below. Treat it as your own memory: the "User" turns are the user's messages and the "Assistant" turns are your own previous replies.

Reply with a short confirmation of the context you carried over (one or two sentences), then wait for the user's next instruction.`;

const SEED_OMISSION_MARKER = '[… middle of the transcript omitted for length …]';

interface Turn {
  label: 'User' | 'Assistant';
  text: string;
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
    if (msg.info.role !== 'user' && msg.info.role !== 'assistant') {
      continue;
    }

    const text = msg.parts
      .filter(
        part =>
          part.type === 'text' &&
          typeof (part as TextPart).text === 'string' &&
          part.synthetic !== true &&
          part.ignored !== true
      )
      .map(part => (part as TextPart).text)
      .join('\n')
      .trim();

    if (!text) {
      continue;
    }

    turns.push({
      label: msg.info.role === 'user' ? 'User' : 'Assistant',
      text,
    });
  }

  // Step 2: no turns → null.
  if (turns.length === 0) {
    return null;
  }

  // Step 3: full transcript fits → return as-is.
  const full = turns.map(serialize).join('\n\n');
  const seed = `${SEED_PREAMBLE}\n\n${full}`;
  if (seed.length <= CONTINUATION_SEED_MAX_CHARS) {
    return seed;
  }

  // Step 4: truncation branch.
  const body = CONTINUATION_SEED_MAX_CHARS - SEED_PREAMBLE.length - 2; // the 2 is '\n\n' after the preamble
  const head = serialize(turns[0]!);

  // Greedily collect trailing turns newest-first.
  const tail: string[] = [];
  for (let i = turns.length - 1; i >= 1; i--) {
    const candidate = [serialize(turns[i]!), ...tail];
    const candidateLen =
      head.length +
      2 +
      SEED_OMISSION_MARKER.length +
      (candidate.length > 0 ? 2 + joinLen(candidate) : 0);
    if (candidateLen <= body) {
      tail.length = 0;
      tail.push(...candidate);
    } else {
      break;
    }
  }

  const omitted = turns.length - 1 - tail.length;
  let resultBody: string;
  if (omitted === 0) {
    resultBody = head + (tail.length > 0 ? `\n\n${tail.join('\n\n')}` : '');
  } else {
    resultBody =
      head + `\n\n${SEED_OMISSION_MARKER}` + (tail.length > 0 ? `\n\n${tail.join('\n\n')}` : '');
  }

  // Safety guard: if head + marker alone exceeds body.
  if (resultBody.length > body) {
    resultBody = `${resultBody.slice(0, body - 1)}…`;
  }

  return `${SEED_PREAMBLE}\n\n${resultBody}`;
}

export type ContinuationDestination =
  | { kind: 'cloud-agent'; repo: string; model: string; variant: string }
  | { kind: 'remote'; instance: InstancePickerInstance };

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
