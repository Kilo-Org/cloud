/**
 * Opt-in, billed upstream reproduction using the real production request transform (not Kilo routing).
 * Live: pnpm exec tsx --tsconfig packages/web-shared/tsconfig.json packages/web-shared/scripts/reproduce-thinking-prefix-mismatch.ts
 * Offline: pnpm exec tsx --tsconfig packages/web-shared/tsconfig.json --test packages/web-shared/scripts/reproduce-thinking-prefix-mismatch.test.ts
 * Requires ANTHROPIC_API_KEY / VERCEL_AI_GATEWAY_API_KEY for the selected targets. No retries.
 * See https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
 */
import { basename } from 'node:path';
import { z } from 'zod';
import { dropThinkingBlocksOnPrefixMismatch } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/thinking-block-binding';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

type MessagesRequest = Extract<GatewayRequest, { kind: 'messages' }>;
type Messages = MessagesRequest['body']['messages'];
type ThinkingMode = 'adaptive' | 'enabled' | 'disabled' | 'absent';
type Target = 'anthropic' | 'vercel';
type Provider = 'anthropic' | 'bedrock' | 'vertex';
type Model = 'sonnet' | 'fable' | 'haiku';
type SeedThinkingMode = 'adaptive' | 'absent';
type Scenario = {
  name: string;
  mode: ThinkingMode;
  changed: boolean;
  helper: boolean;
  explicitError?: boolean;
  betaOnly?: boolean;
  requiredSuccess?: boolean;
};

const BETA = 'thinking-binding-controls-2026-08-01';
const SYSTEM =
  'This task involves multistep reasoning. Think carefully before responding. Session marker: A.';
const PROMPT =
  'Find the least positive integer n satisfying n mod 17 = 11, n mod 19 = 13, and n mod 23 = 17. Also compute n squared mod 97. Please think hard before responding. Return only the two integers.';
const TARGETS = {
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    models: {
      sonnet: 'claude-sonnet-5-5',
      fable: 'claude-fable-5-2',
      haiku: 'claude-haiku-5-5',
    },
    keyName: 'ANTHROPIC_API_KEY',
  },
  vercel: {
    endpoint: 'https://ai-gateway.vercel.sh/v1/messages',
    models: {
      sonnet: 'anthropic/claude-sonnet-5.5',
      fable: 'anthropic/claude-fable-5.2',
      haiku: 'anthropic/claude-haiku-5.5',
    },
    keyName: 'VERCEL_AI_GATEWAY_API_KEY',
  },
} as const;

const adaptive = { mode: 'adaptive', changed: true, helper: true } as const;
export const scenarios: Scenario[] = [
  { ...adaptive, name: 'unchanged-adaptive', changed: false, requiredSuccess: true },
  { ...adaptive, name: 'changed-adaptive-without-helper', helper: false },
  { ...adaptive, name: 'changed-adaptive', requiredSuccess: true },
  { ...adaptive, name: 'changed-absent', mode: 'absent' },
  { ...adaptive, name: 'changed-disabled-without-helper', mode: 'disabled', helper: false },
  { ...adaptive, name: 'changed-disabled', mode: 'disabled' },
  { ...adaptive, name: 'changed-enabled', mode: 'enabled' },
  { ...adaptive, name: 'changed-adaptive-explicit-error', explicitError: true },
  { ...adaptive, name: 'changed-adaptive-beta-only', helper: false, betaOnly: true },
];

export function parseOptions(args: string[]) {
  let target: Target | 'both' = 'both';
  let provider: Provider = 'anthropic';
  let model: Model = 'sonnet';
  let seedThinking: SeedThinkingMode = 'adaptive';
  let vercelByok = false;
  if (args.includes('--help'))
    return { help: true, target, provider, model, seedThinking, vercelByok };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--vercel-byok') {
      vercelByok = true;
      continue;
    }
    const value = args[++i];
    if (flag === '--target' && (value === 'anthropic' || value === 'vercel' || value === 'both')) {
      target = value;
    } else if (
      flag === '--vercel-provider' &&
      (value === 'anthropic' || value === 'bedrock' || value === 'vertex')
    ) {
      provider = value;
    } else if (
      flag === '--model' &&
      (value === 'sonnet' || value === 'fable' || value === 'haiku')
    ) {
      model = value;
    } else if (flag === '--seed-thinking' && (value === 'adaptive' || value === 'absent')) {
      seedThinking = value;
    } else {
      throw new Error(
        'Expected --target anthropic|vercel|both, --vercel-provider anthropic|bedrock|vertex, --model sonnet|fable|haiku, --seed-thinking adaptive|absent, or --vercel-byok; use --help.'
      );
    }
  }
  if (vercelByok && provider !== 'anthropic')
    throw new Error('--vercel-byok requires --vercel-provider anthropic.');
  return { help: false, target, provider, model, seedThinking, vercelByok };
}

export function preflight(targets: Target[], env: NodeJS.ProcessEnv, vercelByok = false) {
  const names = new Set<string>(targets.map(target => TARGETS[target].keyName));
  if (vercelByok && targets.includes('vercel')) names.add('ANTHROPIC_API_KEY');
  const missing = [...names].filter(name => !env[name]?.trim());
  if (missing.length)
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

export function buildRequest(
  target: Target,
  provider: Provider,
  history: Messages,
  scenario: Scenario,
  model: Model = 'sonnet',
  byokKey?: string
) {
  const request: MessagesRequest = {
    kind: 'messages',
    body: {
      model: TARGETS[target].models[model],
      max_tokens: 2_048,
      system: scenario.changed ? SYSTEM.replace('marker: A', 'marker: B') : SYSTEM,
      messages: structuredClone(history),
      output_config: { effort: 'high' },
      ...(target === 'vercel' && {
        providerOptions: {
          gateway: {
            only: [provider],
            sessionAffinity: false,
            ...(byokKey && { byok: { anthropic: [{ apiKey: byokKey }] } }),
          },
        },
      }),
    },
  };
  if (scenario.mode === 'adaptive') {
    request.body.thinking = {
      type: 'adaptive',
      display: 'summarized',
      ...(scenario.explicitError && { block_binding: { prefix_mismatch_behavior: 'error' } }),
    };
  } else if (scenario.mode === 'enabled') {
    request.body.thinking = { type: 'enabled', budget_tokens: 1_024 };
  } else if (scenario.mode === 'disabled') {
    request.body.thinking = { type: 'disabled' };
  }
  const extraHeaders: Record<string, string> = {};
  if (scenario.betaOnly) extraHeaders['anthropic-beta'] = BETA;
  if (scenario.helper) {
    dropThinkingBlocksOnPrefixMismatch({ model: request.body.model, request, extraHeaders });
  }
  return { request, extraHeaders };
}

export function makeSeedScenario(mode: SeedThinkingMode): Scenario {
  return {
    name: 'seed',
    mode,
    changed: false,
    helper: false,
    requiredSuccess: true,
  };
}

function countHistoricalThinkingBlocks(messages: Messages) {
  return messages.reduce((count, message) => {
    if (message.role !== 'assistant' || typeof message.content === 'string') return count;
    return (
      count +
      message.content.filter(
        block => block.type === 'thinking' || block.type === 'redacted_thinking'
      ).length
    );
  }, 0);
}

const tokens = z.number().int().nonnegative();
const messageSchema = z.object({
  type: z.literal('message'),
  role: z.literal('assistant'),
  content: z
    .array(
      z.discriminatedUnion('type', [
        z
          .object({
            type: z.literal('thinking'),
            thinking: z.string(),
            signature: z.string().min(1),
          })
          .passthrough(),
        z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
        z.object({ type: z.literal('redacted_thinking'), data: z.string() }).passthrough(),
      ])
    )
    .min(1),
  stop_reason: z.enum([
    'end_turn',
    'max_tokens',
    'stop_sequence',
    'tool_use',
    'pause_turn',
    'refusal',
    'model_context_window_exceeded',
  ]),
  usage: z.object({
    input_tokens: tokens,
    output_tokens: tokens,
    cache_read_input_tokens: tokens.nullish(),
    cache_creation_input_tokens: tokens.nullish(),
    thinking_tokens: tokens.nullish(),
  }),
  input_transformations: z
    .array(
      z.object({
        type: z.enum(['thinking_dropped', 'thinking_mismatch_allowed']),
        reason: z.enum([
          'prefix_binding_mismatch',
          'model_binding_mismatch',
          'organization_binding_mismatch',
        ]),
        path: z.string().regex(/^messages\.\d+\.content\.\d+$/),
      })
    )
    .optional(),
});
const errorSchema = z.object({ error: z.object({ message: z.string() }) });

export function validateMessage(value: unknown, requireSignedThinking = false) {
  const parsed = messageSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid Messages API response shape.');
  const message = parsed.data;
  if (
    requireSignedThinking &&
    (message.stop_reason !== 'end_turn' ||
      !message.content.some(block => block.type === 'thinking'))
  ) {
    throw new Error(
      'Seed must finish with end_turn and contain signed thinking; adaptive thinking may skip easy tasks.'
    );
  }
  return message;
}

export function sanitizeError(message: string, secrets: string[]) {
  let safe = message;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join('[REDACTED]');
  }
  const printable = [...safe]
    .map(character => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('');
  return printable
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_./+=-]+/gi, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_+/=-]{80,}\b/g, '[REDACTED]')
    .slice(0, 1_000);
}

export function classifyError(message: string) {
  const prefixMismatch =
    /bound to a different conversation|prefix[_ ]binding[_ ]mismatch|(?:system|tools).*differs|content (?:before|that preceded) this block/i.test(
      message
    );
  return {
    prefixMismatch,
    betaRequirementMentioned:
      /requires[^.]*thinking-binding-controls|thinking-binding-controls[^.]*required/i.test(
        message
      ),
    unsupportedThinkingMode:
      !prefixMismatch &&
      /(?:thinking|adaptive|enabled|disabled|budget_tokens).*(?:not supported|unsupported|must be|only.*adaptive)|(?:not supported|unsupported).*thinking|to turn thinking off on this model/i.test(
        message
      ),
  };
}

async function runTarget(
  target: Target,
  provider: Provider,
  model: Model,
  seedThinking: SeedThinkingMode,
  key: string,
  secrets: string[],
  byokKey?: string
) {
  const history: Messages = [{ role: 'user', content: PROMPT }];
  const seed = makeSeedScenario(seedThinking);
  let failed = false;
  for (const scenario of [seed, ...scenarios]) {
    const { request, extraHeaders } = buildRequest(
      target,
      provider,
      history,
      scenario,
      model,
      byokKey
    );
    const binding = request.body.thinking?.block_binding;
    const report = {
      target,
      provider: target === 'vercel' ? provider : 'anthropic',
      model: request.body.model,
      byok: target === 'vercel' && Boolean(byokKey),
      case: scenario.name,
      inputThinkingMode: scenario.mode,
      thinkingMode: request.body.thinking?.type ?? 'absent',
      historicalThinkingBlocksBefore: countHistoricalThinkingBlocks(history),
      historicalThinkingBlocksAfter: countHistoricalThinkingBlocks(request.body.messages),
      bindingOption: binding?.prefix_mismatch_behavior ?? binding?.mismatch_behavior ?? null,
      betaPresent: Object.values(extraHeaders).some(value => value.includes(BETA)),
    };
    const emit = (fields: Record<string, unknown>) =>
      console.log(JSON.stringify({ ...report, ...fields }));
    let response: Response | undefined;
    let value: unknown;
    try {
      response = await fetch(TARGETS[target].endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': key,
          ...extraHeaders,
        },
        body: JSON.stringify(request.body),
      });
      value = await response.json();
    } catch {
      emit({
        httpStatus: response?.status ?? null,
        result: response ? 'invalid_response' : 'transport_error',
        error: 'Fetch timed out/failed or response was not JSON; not retried.',
      });
      failed = true;
      if (scenario === seed) break;
      continue;
    }
    if (!response.ok) {
      const parsedError = errorSchema.safeParse(value);
      const message = parsedError.success
        ? parsedError.data.error.message
        : 'No recognized error message.';
      const flags = classifyError(message);
      emit({
        httpStatus: response.status,
        ...flags,
        result: flags.prefixMismatch
          ? 'prefix_mismatch'
          : flags.unsupportedThinkingMode
            ? 'unsupported_thinking_mode'
            : 'http_error',
        error: sanitizeError(message, secrets),
      });
      if (
        scenario.requiredSuccess ||
        (scenario.helper && !scenario.explicitError && flags.prefixMismatch) ||
        !(response.status === 400 && (flags.prefixMismatch || flags.unsupportedThinkingMode))
      )
        failed = true;
      if (scenario === seed) break;
      continue;
    }
    try {
      const message = validateMessage(value, scenario === seed);
      const transformations = message.input_transformations ?? [];
      const prefixMismatch = transformations.some(
        entry => entry.reason === 'prefix_binding_mismatch'
      );
      const accountBindingChanged = transformations.some(
        entry => entry.reason === 'organization_binding_mismatch'
      );
      const prefixDropped = transformations.some(
        entry => entry.type === 'thinking_dropped' && entry.reason === 'prefix_binding_mismatch'
      );
      emit({
        httpStatus: response.status,
        result: accountBindingChanged
          ? 'account_binding_mismatch_inconclusive'
          : scenario.explicitError
            ? 'no_prefix_error_inconclusive'
            : 'success',
        prefixMismatch,
        accountBindingChanged,
        helperPrefixMitigationVerified:
          scenario.helper && binding?.prefix_mismatch_behavior === 'drop_block' && prefixDropped,
        betaRequirementMentioned: false,
        stop_reason: message.stop_reason,
        usage: message.usage,
        input_transformations: message.input_transformations ?? null,
      });
      if (scenario.requiredSuccess && message.stop_reason !== 'end_turn') failed = true;
      if (!scenario.changed && prefixMismatch) failed = true;
      if (scenario === seed) {
        for (const block of message.content) {
          if (block.type === 'thinking') secrets.push(block.thinking, block.signature);
          else if (block.type === 'redacted_thinking') secrets.push(block.data);
          else secrets.push(block.text);
        }
        history.push(
          { role: 'assistant', content: message.content },
          { role: 'user', content: 'What is n + 1? Answer only the integer.' }
        );
      }
    } catch (error) {
      emit({
        httpStatus: response.status,
        result: 'invalid_response',
        error: sanitizeError(error instanceof Error ? error.message : 'Invalid response.', secrets),
      });
      failed = true;
      if (scenario === seed) break;
    }
  }
  return failed;
}

async function main() {
  const secrets = [
    process.env.ANTHROPIC_API_KEY ?? '',
    process.env.VERCEL_AI_GATEWAY_API_KEY ?? '',
  ];
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      console.log(
        'Usage: pnpm exec tsx --tsconfig packages/web-shared/tsconfig.json packages/web-shared/scripts/reproduce-thinking-prefix-mismatch.ts [--target anthropic|vercel|both] [--vercel-provider anthropic|bedrock|vertex] [--model sonnet|fable|haiku] [--seed-thinking adaptive|absent] [--vercel-byok]\nOpt-in billed calls; default both, provider anthropic, model sonnet, seed thinking adaptive. Required keys: ANTHROPIC_API_KEY and/or VERCEL_AI_GATEWAY_API_KEY. --vercel-byok also requires ANTHROPIC_API_KEY and supplies its account to Vercel (anthropic provider only; credential fallback remains possible). Only fixed upstream endpoints are called; no Kilo-hosted routing. JSON metadata only; signed history stays in memory and never crosses targets. No retries. Adaptive thinking may skip easy tasks; a seed without signed thinking fails. --seed-thinking absent omits thinking on the seed call. Explicit nonadaptive scenarios strip historical assistant thinking blocks via the production helper. Default mismatch enforcement varies by account. A 200 explicit-error control or account-binding drop is inconclusive, not a reproduced prefix error.'
      );
      return;
    }
    const targets: Target[] =
      options.target === 'both' ? ['anthropic', 'vercel'] : [options.target];
    preflight(targets, process.env, options.vercelByok);
    let failed = false;
    for (const target of targets) {
      const key = process.env[TARGETS[target].keyName];
      if (!key) throw new Error('Required credential disappeared after preflight.');
      const byokKey =
        target === 'vercel' && options.vercelByok ? process.env.ANTHROPIC_API_KEY : undefined;
      if (
        await runTarget(
          target,
          options.provider,
          options.model,
          options.seedThinking,
          key,
          secrets,
          byokKey
        )
      )
        failed = true;
    }
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.log(
      JSON.stringify({
        result: 'setup_error',
        error: sanitizeError(error instanceof Error ? error.message : 'Setup failed.', secrets),
      })
    );
    process.exitCode = 1;
  }
}

if (basename(process.argv[1] ?? '') === 'reproduce-thinking-prefix-mismatch.ts') void main();
