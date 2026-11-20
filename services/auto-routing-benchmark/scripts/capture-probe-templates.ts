import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import { promptText } from '../src/decider-prompt';
import type { ProbeTranscript } from '../src/datasets/probe-transcripts';
import { startCaptureContainers } from '../src/probe/capture-containers';
import { writeProbeCaptureFiles } from '../src/probe/capture-files';
import { probeFamily, type ProbeFamily } from '../src/probe/family';
import { ProbeTemplatesSchema } from '../src/probe/request';

// Regenerates the probe fixtures from the pinned CLI: builds the runner image with that CLI,
// drives it against scripts/probe-gateway.mjs (which serves the public catalog and needs no
// provider), and stores each family's request as a template plus a canonical capture.
// Run it on a machine with Docker after a CLI bump:
//
//   tsx scripts/capture-probe-templates.ts --pool /tmp/efficient-pool.json
//
// `--pool` is a JSON array of `{ "model": string, "variant": string | null }` (the live
// Router pool). Every family in it gets a template; a family whose endpoint the probe cannot
// speak is recorded under `unsupportedFamilies` with the reason the worker reports.
// `--only <family>` captures one family and merges it into the existing templates file,
// keeping every other family and the rest of the bookkeeping. A family that run finds
// unsupported loses its template entry and its capture file in the same write.

const CAPTURE_TASK = 'Run one command that prints two lines, then report what it printed.';
const CAPTURE_SYSTEM_PROMPT =
  'You are a precise coding agent with file and terminal tools available. Complete the task exactly as specified.';

const PLACEHOLDER = {
  model: '{{MODEL_ID}}',
  today: '{{TODAY}}',
  effort: '{{EFFORT}}',
  tools: '{{TOOLS}}',
} as const;

const EFFORT_ORDER = ['high', 'medium', 'low', 'max', 'xhigh', 'minimal', 'none'] as const;

// Encrypted reasoning lets a later turn carry the model's reasoning; the pinned CLI asks
// for it on every Responses request (gateway pilot, CLI 7.8.27).
const RESPONSES_INCLUDE = ['reasoning.encrypted_content'];

const ArgsSchema = z.object({
  pool: z.string().min(1),
  cliVersion: z.string().min(1).default('7.8.27'),
  catalogUrl: z.string().min(1).default('https://app.kilo.ai/api/openrouter/models'),
  image: z.string().min(1).default('probe-capture'),
  out: z.string().min(1).default('src/datasets'),
  only: z.array(z.string()).default([]),
});

const PoolEntrySchema = z.object({ model: z.string().min(1), variant: z.string().nullable() });

const CatalogSchema = z.object({
  // Loose: the CLI validates the whole entry, so the capture serves it back verbatim.
  data: z.array(
    z.looseObject({
      id: z.string().min(1),
      supported_parameters: z.array(z.string()).optional(),
      architecture: z.object({ output_modalities: z.array(z.string()).optional() }).optional(),
      opencode: z
        .object({
          prompt: z.string().nullish(),
          ai_sdk_provider: z.string().nullish(),
          variants: z
            .record(
              z.string(),
              z.object({ reasoning: z.object({ effort: z.string().optional() }).optional() })
            )
            .optional(),
        })
        .optional(),
    })
  ),
});

type Catalog = z.infer<typeof CatalogSchema>;
type CatalogModel = Catalog['data'][number];
type PoolEntry = z.infer<typeof PoolEntrySchema>;

type Captured = { headers: Record<string, string>; body: Record<string, unknown> };

const CapturedLineSchema = z.object({
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown(),
  status: z.number(),
});

function sh(
  command: string,
  args: string[],
  options: { input?: string; allowFailure?: boolean } = {}
) {
  const result = spawnSync(command, args, {
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`
    );
  }
  return result;
}

type Representative = {
  family: ProbeFamily;
  model: string;
  variant: string | null;
  effort: string | null;
};

// The CLI hides a catalog entry unless its `supported_parameters` list includes "tools"
// (packages/kilo-gateway/src/api/models.ts `supportsTools`) and its output is text, so a
// representative the CLI would not list cannot produce a request to capture.
function servedByCli(model: CatalogModel): boolean {
  const params = model.supported_parameters;
  const tools = !params || params.length === 0 || params.includes('tools');
  const image = (model.architecture?.output_modalities ?? []).includes('image');
  return tools && !image;
}

type VariantChoice = { variant: string | null; effort: string | null; rank: number };

// The variant the capture drives: "high" when the model has it, else its highest effort.
function variantChoice(model: CatalogModel): VariantChoice {
  const variants = model.opencode?.variants ?? {};
  const rated = Object.entries(variants).flatMap(([variant, value]) => {
    const effort = value.reasoning?.effort;
    if (!effort) return [];
    const rank = (EFFORT_ORDER as readonly string[]).indexOf(effort);
    return [{ variant, effort, rank: rank === -1 ? EFFORT_ORDER.length : rank }];
  });
  const best = rated.toSorted((a, b) => a.rank - b.rank || a.variant.localeCompare(b.variant))[0];
  return best ?? { variant: null, effort: null, rank: EFFORT_ORDER.length };
}

type FamilySelection = {
  chosen: Map<string, Representative>;
  unsupported: Record<string, string>;
};

/**
 * One served representative per family the pool needs. A family whose only members the CLI
 * hides (or whose endpoint the probe cannot speak) is recorded as unsupported instead, so
 * the worker fails those pairs' probe lane with that reason rather than scoring them.
 */
function representatives(pool: readonly PoolEntry[], catalog: Catalog): FamilySelection {
  const byModel = new Map(catalog.data.map(model => [model.id, model]));
  const poolModels = new Set(pool.map(entry => entry.model));
  const needed = new Map<string, ProbeFamily>();
  for (const entry of pool) {
    const model = byModel.get(entry.model);
    if (model) needed.set(probeFamily(model).key, probeFamily(model));
  }
  const chosen = new Map<string, Representative>();
  const unsupported: Record<string, string> = {};
  for (const [key, family] of needed) {
    const candidates = catalog.data
      .filter(model => probeFamily(model).key === key && servedByCli(model))
      .map(model => ({ model, choice: variantChoice(model), inPool: poolModels.has(model.id) }))
      .toSorted(
        (a, b) =>
          Number(b.inPool) - Number(a.inPool) ||
          a.choice.rank - b.choice.rank ||
          a.model.id.localeCompare(b.model.id)
      );
    const best = candidates[0];
    if (!best) {
      unsupported[key] =
        `${key}: no catalog member is served by the CLI (every entry omits "tools"), so there is no request to capture.`;
      continue;
    }
    chosen.set(key, {
      family,
      model: best.model.id,
      variant: best.choice.variant,
      effort: best.choice.effort,
    });
  }
  return { chosen, unsupported };
}

function capturedRequest(logFile: string, suffix: string): Captured {
  const lines = readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => CapturedLineSchema.parse(JSON.parse(line)));
  const posts = lines.filter(
    line => line.status === 200 && line.url.endsWith(suffix) && line.body !== null
  );
  if (posts.length < 2) {
    throw new Error(`the CLI sent ${posts.length} ${suffix} requests, expected the follow-up`);
  }
  const last = posts.at(-1);
  if (!last) throw new Error(`no ${suffix} request captured`);
  return {
    headers: last.headers ?? {},
    body: z.record(z.string(), z.unknown()).parse(last.body),
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part =>
      typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string'
        ? part.text
        : ''
    )
    .join('');
}

// The CLI appends its environment block to the last user message; the request it stands for
// is the task, not the harness line.
function stripEnvironmentDetails(text: string): string {
  const marker = text.indexOf('\n\n<environment_details>');
  return marker === -1 ? text : text.slice(0, marker);
}

type History = { task: string; text: string; command: string; description: string; output: string };

type ContentBlock = Record<string, unknown>;

function blocksOf(content: unknown): ContentBlock[] {
  return Array.isArray(content)
    ? content.map(part => z.record(z.string(), z.unknown()).parse(part))
    : [];
}

// Anthropic encodes the history as user/assistant turns whose content blocks carry the tool
// call (`tool_use`) and its result (`tool_result`), so neither the chat nor the Responses
// reading applies.
function anthropicHistory(body: Record<string, unknown>): History {
  const messages = z.array(z.record(z.string(), z.unknown())).parse(body.messages);
  const user = messages.find(message => message.role === 'user');
  const assistant = messages.find(message => message.role === 'assistant');
  if (!user) throw new Error('captured messages request has no user turn');
  const userBlocks = blocksOf(user.content);
  const task = stripEnvironmentDetails(
    userBlocks
      .filter(block => block.type === 'text')
      .map(block => String(block.text ?? ''))
      .join('')
  );
  const assistantBlocks = blocksOf(assistant?.content);
  const text = assistantBlocks
    .filter(block => block.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('');
  const call = messages
    .flatMap(message => blocksOf(message.content))
    .find(block => block.type === 'tool_use');
  if (!call) throw new Error('captured messages request has no tool_use block');
  const args = z.object({ command: z.string(), description: z.string() }).parse(call.input ?? {});
  const result = messages
    .flatMap(message => blocksOf(message.content))
    .find(block => block.type === 'tool_result');
  if (!result) throw new Error('captured messages request has no tool_result block');
  const output =
    typeof result.content === 'string'
      ? result.content
      : blocksOf(result.content)
          .map(block => String(block.text ?? ''))
          .join('');
  return { task, text, command: args.command, description: args.description, output };
}

function historyOf(body: Record<string, unknown>): History {
  if (body.system !== undefined) return anthropicHistory(body);
  if (Array.isArray(body.messages)) {
    const messages = body.messages as Record<string, unknown>[];
    const user = messages.find(message => message.role === 'user');
    const assistant = messages.find(message => message.role === 'assistant');
    const tool = messages.find(message => message.role === 'tool');
    if (!user || !assistant || !tool) {
      throw new Error('captured chat request has no user, assistant and tool message');
    }
    const calls = z
      .array(
        z.object({
          function: z.object({ arguments: z.string() }),
        })
      )
      .parse(assistant.tool_calls);
    const args = z
      .object({ command: z.string(), description: z.string() })
      .parse(JSON.parse(calls[0]?.function.arguments ?? '{}'));
    return {
      task: stripEnvironmentDetails(textOf(user.content)),
      text: textOf(assistant.content),
      command: args.command,
      description: args.description,
      output: textOf(tool.content),
    };
  }
  const input = z.array(z.record(z.string(), z.unknown())).parse(body.input);
  const user = input.find(item => item.role === 'user');
  const assistant = input.find(item => item.role === 'assistant');
  const call = input.find(item => item.type === 'function_call');
  const output = input.find(item => item.type === 'function_call_output');
  if (!user || !call || !output) {
    throw new Error('captured responses request has no user, function call and output');
  }
  const args = z
    .object({ command: z.string(), description: z.string() })
    .parse(JSON.parse(String(call.arguments)));
  return {
    task: stripEnvironmentDetails(textOf(user.content)),
    text: assistant ? textOf(assistant.content) : '',
    command: args.command,
    description: args.description,
    output: String(output.output),
  };
}

// Only whole-token values are replaced: the model id and the request day anywhere, the
// effort only inside the reasoning params (the word "high" also occurs in prose).
function placeholders(
  value: unknown,
  replacements: readonly (readonly [string, string])[]
): unknown {
  if (typeof value === 'string') {
    return replacements.reduce((result, [from, to]) => result.replaceAll(from, to), value);
  }
  if (Array.isArray(value)) return value.map(entry => placeholders(entry, replacements));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, placeholders(entry, replacements)])
    );
  }
  return value;
}

function main() {
  const { values } = parseArgs({
    options: {
      pool: { type: 'string' },
      'cli-version': { type: 'string', default: '7.8.27' },
      'catalog-url': { type: 'string', default: 'https://app.kilo.ai/api/openrouter/models' },
      image: { type: 'string', default: 'probe-capture' },
      out: { type: 'string', default: 'src/datasets' },
      only: { type: 'string', multiple: true, default: [] },
    },
  });
  const args = ArgsSchema.parse({
    pool: values.pool,
    cliVersion: values['cli-version'],
    catalogUrl: values['catalog-url'],
    image: values.image,
    out: values.out,
    only: values.only,
  });
  const pool = z.array(PoolEntrySchema).parse(JSON.parse(readFileSync(args.pool, 'utf8')));
  const catalog = CatalogSchema.parse(JSON.parse(sh('curl', ['-fsSL', args.catalogUrl]).stdout));
  const { chosen, unsupported } = representatives(pool, catalog);
  const catalogById = new Map(catalog.data.map(model => [model.id, model]));

  const workDir = join(tmpdir(), 'probe-capture');
  mkdirSync(workDir, { recursive: true });
  // The gateway serves the catalog the CLI would fetch in production.
  const catalogFile = join(workDir, 'catalog.json');
  writeFileSync(catalogFile, JSON.stringify(catalog));
  copyFileSync(join(process.cwd(), 'scripts/probe-gateway.mjs'), join(workDir, 'gateway.mjs'));
  const logFile = join(workDir, 'gateway.jsonl');
  writeFileSync(logFile, '');

  const image = `${args.image}:${args.cliVersion}`;
  const runner = 'probe-capture-runner';
  const gateway = 'probe-capture-gateway';
  sh('docker', [
    'build',
    '-q',
    '-t',
    image,
    '--build-arg',
    `KILO_CLI_VERSION=${args.cliVersion}`,
    'container',
  ]);
  startCaptureContainers({
    sh,
    image,
    runner,
    gateway,
    workDir,
    catalogFile,
    logFile,
  });

  const families: Record<string, unknown> = {};
  const captures: Record<string, object> = {};
  const unsupportedFamilies: Record<string, string> = { ...unsupported };
  const today = new Date().toDateString();

  try {
    for (const [key, representative] of [...chosen].sort(([a], [b]) => a.localeCompare(b))) {
      if (args.only.length > 0 && !args.only.includes(key)) continue;
      writeFileSync(logFile, '');
      if (!catalogById.has(representative.model)) {
        throw new Error(`${key}: ${representative.model} is not in the catalog`);
      }
      const env = [
        `KILO_AUTH_CONTENT=${JSON.stringify({ kilo: { type: 'api', key: 'capture-token', organizationId: 'capture-org' } })}`,
        'KILO_API_URL=http://127.0.0.1:8787',
        'KILO_ORG_ID=capture-org',
        'KILO_DISABLE_SESSION_INGEST=1',
        'NO_COLOR=1',
      ];
      const command = ['run', '--format', 'json', '--auto', '-m', `kilo/${representative.model}`];
      if (representative.variant !== null) command.push('--variant', representative.variant);
      const run = sh(
        'docker',
        [
          'exec',
          '-i',
          '-w',
          '/tmp/capture',
          ...env.flatMap(value => ['-e', value]),
          runner,
          'kilo',
          ...command,
        ],
        {
          // The CLI reads its task from stdin verbatim; the probe sends the same folded
          // prompt the benchmark's cases carry.
          input: promptText({ systemPrompt: CAPTURE_SYSTEM_PROMPT, userPrompt: CAPTURE_TASK }),
          allowFailure: true,
        }
      );
      const suffix =
        representative.family.endpoint === 'responses'
          ? '/responses'
          : representative.family.endpoint === 'anthropic'
            ? '/messages'
            : '/chat/completions';
      let captured: Captured;
      try {
        captured = capturedRequest(logFile, suffix);
      } catch (error) {
        throw new Error(
          `${key}: ${error instanceof Error ? error.message : String(error)}\n${run.stdout}\n${run.stderr}`
        );
      }
      const history = historyOf(captured.body);
      const expected = promptText({
        systemPrompt: CAPTURE_SYSTEM_PROMPT,
        userPrompt: CAPTURE_TASK,
      });
      if (history.task !== expected) {
        throw new Error(
          `${key}: the captured task is not the prompt the builder reproduces\ncaptured: ${JSON.stringify(history.task.slice(0, 120))}\nbuilt:    ${JSON.stringify(expected.slice(0, 120))}`
        );
      }
      // The CLI's tool set varies with the model (the prompt families carry different tools),
      // so every family keeps the schemas it actually sends.
      const capturedTools = z.array(z.record(z.string(), z.unknown())).parse(captured.body.tools);
      // The system prompt is the first chat/Responses item and, on the Messages API, the
      // `system` field instead of a turn.
      const systemItem =
        representative.family.endpoint === 'anthropic'
          ? { role: 'system', content: captured.body.system }
          : Array.isArray(captured.body.messages)
            ? (captured.body.messages as Record<string, unknown>[])[0]
            : (captured.body.input as Record<string, unknown>[])[0];
      // A reasoning variant reaches a chat body as `reasoning.effort` from the model's
      // catalog variants; the Responses path of the loopback catalog drops it, so those
      // families record the shape the pinned CLI sends in production with an effort pair:
      // `reasoning.effort` plus encrypted reasoning, and the prompt in the developer role.
      // The gateway pilot's meta/muse-ember requests (CLI 7.8.27) are the reference.
      const effortShape =
        representative.family.endpoint === 'responses' && representative.effort !== null
          ? {
              params: {
                reasoning: { effort: PLACEHOLDER.effort },
                include: RESPONSES_INCLUDE,
              },
              systemRole: 'developer' as const,
            }
          : null;
      const capturedReasoning = captured.body.reasoning ?? null;
      // The loopback catalog does not apply variant options, so a Messages request is recorded
      // the way the CLI builds it in production: the catalog variant becomes `thinking.type`
      // and `output_config.effort` (packages/opencode/src/kilocode/provider-options.ts +
      // @ai-sdk/anthropic 3.0.111). The builder derives the same pair, so it is not a param.
      const anthropicEffortShape =
        representative.family.endpoint === 'anthropic'
          ? representative.effort === null
            ? null
            : representative.effort === 'none'
              ? { thinking: { type: 'disabled' } }
              : {
                  thinking: { type: 'adaptive' },
                  output_config: { effort: representative.effort },
                }
          : null;
      // Messages families carry their variant as the derived `thinking`/`output_config`
      // shape, so nothing is left in the template's params.
      const capturedVariantParams =
        representative.family.endpoint === 'anthropic'
          ? null
          : capturedReasoning === null
            ? null
            : { reasoning: capturedReasoning };
      const variantParams = effortShape
        ? effortShape.params
        : capturedVariantParams === null
          ? null
          : (placeholders(
              capturedVariantParams,
              representative.effort === null
                ? []
                : [[representative.effort, PLACEHOLDER.effort] as const]
            ) as Record<string, unknown>);
      const body: Record<string, unknown> = anthropicEffortShape
        ? {
            ...captured.body,
            thinking: anthropicEffortShape.thinking,
            ...('output_config' in anthropicEffortShape
              ? { output_config: anthropicEffortShape.output_config }
              : {}),
          }
        : effortShape
          ? {
              ...captured.body,
              reasoning: { effort: representative.effort },
              include: RESPONSES_INCLUDE,
              input: [
                {
                  ...(captured.body.input as Record<string, unknown>[])[0],
                  role: effortShape.systemRole,
                },
                ...(captured.body.input as Record<string, unknown>[]).slice(1),
              ],
            }
          : captured.body;
      const fixed: Record<string, unknown> = {};
      const variantOwned =
        representative.family.endpoint === 'anthropic'
          ? ['thinking', 'output_config']
          : ['reasoning'];
      for (const [name, value] of Object.entries(body)) {
        if (['model', 'messages', 'input', 'tools', 'description', 'system'].includes(name)) {
          continue;
        }
        if (variantOwned.includes(name)) continue;
        fixed[name] = value;
      }
      // The variant shape is derived per pair (src/probe/request.ts); the base is what the
      // CLI sends for a pair without one.
      if (representative.family.endpoint === 'anthropic') {
        fixed.thinking = { type: 'disabled' };
      }
      const identity = [
        [representative.model, PLACEHOLDER.model],
        [today, PLACEHOLDER.today],
      ] as const;
      const systemPartParams = Array.isArray(systemItem?.content)
        ? Object.fromEntries(
            Object.entries(
              z.record(z.string(), z.unknown()).parse((systemItem.content as unknown[])[0])
            ).filter(([name]) => name !== 'text' && name !== 'type')
          )
        : {};
      // The Messages API marks its tool blocks for prompt caching; the probe sends the same
      // marker so its request stays comparable.
      const toolBlockParams =
        representative.family.endpoint === 'anthropic'
          ? (() => {
              const blocks = z
                .array(z.record(z.string(), z.unknown()))
                .parse(captured.body.messages)
                .flatMap(message =>
                  Array.isArray(message.content)
                    ? (message.content as Record<string, unknown>[])
                    : []
                );
              const block = blocks.find(
                candidate => candidate.type === 'tool_use' || candidate.type === 'tool_result'
              );
              return Object.fromEntries(
                Object.entries(block ?? {}).filter(
                  ([name]) =>
                    !['type', 'id', 'name', 'input', 'tool_use_id', 'content'].includes(name)
                )
              );
            })()
          : {};
      families[key] = {
        endpoint: representative.family.endpoint,
        tools: capturedTools,
        systemRole: effortShape?.systemRole ?? systemItem?.role,
        systemPrompt: placeholders(textOf(systemItem?.content), identity),
        systemParts: Array.isArray(systemItem?.content),
        systemPartParams,
        toolBlockParams,
        params: fixed,
        variantParams,
        sendsDescription: typeof captured.body.description === 'string',
        headers: captured.headers,
        representative,
      };
      const transcript: Omit<ProbeTranscript, 'taskType' | 'subtaskType' | 'check' | 'id'> = {
        systemPrompt: CAPTURE_SYSTEM_PROMPT,
        userPrompt: CAPTURE_TASK,
        session: {
          files: {},
          steps: [
            {
              text: history.text,
              calls: [
                {
                  tool: 'bash',
                  command: history.command,
                  description: history.description,
                  output: history.output,
                },
              ],
            },
          ],
          message: 'Continue.',
        },
      };
      captures[key] = {
        family: representative.family.key,
        model: representative.model,
        variant: representative.variant,
        effort: representative.effort,
        // Families whose request carries the model's catalog description; the builder adds it
        // back from the pair's catalog entry.
        description:
          typeof captured.body.description === 'string' ? captured.body.description : null,
        transcript,
        body: placeholders(
          {
            ...body,
            tools: PLACEHOLDER.tools,
            model: PLACEHOLDER.model,
          },
          identity
        ),
      };
      console.log(
        `${key}: ${representative.model}${representative.variant ? ` (${representative.variant})` : ''} -> ${suffix}`
      );
    }
  } finally {
    sh('docker', ['rm', '-f', runner, gateway], { allowFailure: true });
  }

  for (const key of args.only) {
    if (!(key in families) && !(key in unsupportedFamilies)) {
      throw new Error(`--only ${key} names a family the pool does not need`);
    }
  }
  const templatesPath = join(args.out, 'probe-templates.json');
  const captured = ProbeTemplatesSchema.parse({
    cliVersion: args.cliVersion,
    families,
    unsupportedFamilies,
  });
  const existing =
    args.only.length > 0
      ? ProbeTemplatesSchema.parse(JSON.parse(readFileSync(templatesPath, 'utf8')))
      : undefined;
  if (existing && existing.cliVersion !== args.cliVersion) {
    console.warn(
      `${templatesPath} now mixes CLI ${existing.cliVersion} templates with ${args.cliVersion} captures; recapture every family to align the version.`
    );
  }
  // A family this run found unsupported loses its template entry and its capture together.
  const { templates: written, removedFiles } = writeProbeCaptureFiles({
    out: args.out,
    cliVersion: args.cliVersion,
    existing,
    captured,
    scope: args.only,
    captures,
  });
  if (removedFiles.length > 0) {
    console.log(`removed ${removedFiles.join(', ')}: the family is unsupported now`);
  }
  console.log(
    `wrote ${Object.keys(written.families).length} families and ${Object.keys(captures).length} captures to ${args.out}`
  );
  // The pool coverage the worker will see: every pair's family and whether it can run.
  const byModel = new Map(catalog.data.map(model => [model.id, model]));
  const seen = new Set<string>();
  const missing = new Set<string>();
  for (const entry of pool) {
    const model = byModel.get(entry.model);
    if (!model) {
      missing.add(entry.model);
      continue;
    }
    const { key, endpoint } = probeFamily(model);
    if (seen.has(key)) continue;
    seen.add(key);
    const state = families[key] ? 'captured' : `UNSUPPORTED (${endpoint})`;
    console.log(`pool: ${entry.model} -> ${key} ${state}`);
  }
  for (const model of missing) console.log(`pool: ${model} -> not in the catalog`);
}

main();
