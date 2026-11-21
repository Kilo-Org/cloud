import * as z from 'zod';
import templatesJson from '../datasets/probe-templates.json';
import type { ProbeTranscript } from '../datasets/probe-transcripts';
import { promptText } from '../decider-prompt';
import type { ProbeFamily } from './family';

const ProbeToolSchema = z.record(z.string(), z.unknown());

export const ProbeEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const ProbeTemplateSchema = z.object({
  endpoint: z.enum(['chat', 'responses', 'anthropic']),
  // Exactly the schemas the CLI sent for this family at the captured CLI version.
  tools: z.array(ProbeToolSchema).min(1),
  systemRole: z.enum(['system', 'developer']),
  // Byte-identical to the captured prompt except for the model id and the request day.
  systemPrompt: z.string().min(1),
  // The CLI wraps a chat system prompt in a one-part content array; Responses sends text.
  systemParts: z.boolean().default(false),
  // Extra fields the CLI puts on that single system part (`prompt_cache_breakpoint` on the
  // OpenAI Responses families), captured verbatim.
  systemPartParams: z.record(z.string(), z.unknown()).default({}),
  // What the CLI puts on every `tool_use`/`tool_result` block it sends to the Messages API
  // (`{cache_control: {type: 'ephemeral'}}`), or null for the other endpoints.
  toolBlockParams: z.record(z.string(), z.unknown()).default({}),
  params: z.record(z.string(), z.unknown()),
  // Merged into `params` for a pair with a reasoning variant; null when the CLI sends nothing.
  variantParams: z.record(z.string(), z.unknown()).nullable(),
  sendsDescription: z.boolean(),
  // Header names and static values as the CLI sent them; per-run values arrive empty.
  headers: z.record(z.string(), z.string()).default({}),
  representative: z.object({
    model: z.string().min(1),
    variant: z.string().nullable(),
    effort: ProbeEffortSchema.nullable(),
  }),
});

export type ProbeTemplate = z.infer<typeof ProbeTemplateSchema>;

export const ProbeTemplatesSchema = z.object({
  cliVersion: z.string().min(1),
  families: z.record(z.string(), ProbeTemplateSchema),
  // Families this worker cannot build (the CLI sends them to another endpoint).
  unsupportedFamilies: z.record(z.string(), z.string()).default({}),
});

export type ProbeTemplates = z.infer<typeof ProbeTemplatesSchema>;

/**
 * A `--only` capture rewrites part of the templates file: every family in `scope` takes the
 * freshly captured outcome (a template or an unsupported reason) and every other family,
 * template or reason, is preserved from `existing`.
 */
export function mergeProbeTemplates(
  existing: ProbeTemplates,
  captured: ProbeTemplates,
  scope: readonly string[]
): ProbeTemplates {
  const families = { ...existing.families };
  const unsupportedFamilies = { ...existing.unsupportedFamilies };
  const scoped = new Set(scope);
  for (const key of scoped) {
    delete families[key];
    delete unsupportedFamilies[key];
  }
  for (const [key, template] of Object.entries(captured.families)) families[key] = template;
  for (const [key, reason] of Object.entries(captured.unsupportedFamilies)) {
    if (scoped.has(key) && !(key in families)) unsupportedFamilies[key] = reason;
  }
  return { cliVersion: captured.cliVersion, families, unsupportedFamilies };
}

export const PROBE_TEMPLATES: ProbeTemplates = ProbeTemplatesSchema.parse(templatesJson);

export const PROBE_UNSUPPORTED_ENDPOINT_REASON = (family: ProbeFamily): string =>
  `Probe lane cannot run: the ${family.endpoint} endpoint of family ${family.key} has no request template.`;
export const PROBE_MISSING_TEMPLATE_REASON = (family: ProbeFamily): string =>
  `Probe lane cannot run: family ${family.key} has no captured request template.`;

/** The template a family's requests are built from, or the reason this worker cannot build one. */
export function probeTemplate(
  family: ProbeFamily
): { template: ProbeTemplate } | { unsupportedReason: string } {
  const template = PROBE_TEMPLATES.families[family.key];
  if (!template) {
    return {
      unsupportedReason:
        PROBE_TEMPLATES.unsupportedFamilies[family.key] ?? PROBE_MISSING_TEMPLATE_REASON(family),
    };
  }
  return { template };
}

export const PROBE_MODEL_PLACEHOLDER = '{{MODEL_ID}}';
export const PROBE_TODAY_PLACEHOLDER = '{{TODAY}}';
export const PROBE_EFFORT_PLACEHOLDER = '{{EFFORT}}';

function fillPrompt(text: string, model: string, today: string): string {
  return text.replaceAll(PROBE_MODEL_PLACEHOLDER, model).replaceAll(PROBE_TODAY_PLACEHOLDER, today);
}

function fillEffort(value: unknown, effort: string): unknown {
  if (typeof value === 'string') return value.replaceAll(PROBE_EFFORT_PLACEHOLDER, effort);
  if (Array.isArray(value)) return value.map(entry => fillEffort(entry, effort));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, fillEffort(entry, effort)])
    );
  }
  return value;
}

function mergeDeep(
  target: Record<string, unknown>,
  source: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = merged[key];
    merged[key] =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof current === 'object' &&
      current !== null &&
      !Array.isArray(current)
        ? mergeDeep(current as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return merged;
}

export type ProbeRequestInput = {
  template: ProbeTemplate;
  model: string;
  description: string | null;
  effort: string | null;
  transcript: ProbeTranscript;
  cutAfterStep: number;
  /** `Date#toDateString` of the request day, as the CLI writes it into its environment block. */
  today: string;
};

function callId(stepIndex: number, callIndex: number): string {
  return `call_probe_${stepIndex}_${callIndex}`;
}

function callArguments(command: string, description: string): string {
  return JSON.stringify({ command, description });
}

// A Messages-API variant is two provider options, not one param object: `thinking.type`
// and `output_config.effort` (packages/opencode/src/kilocode/provider-options.ts builds
// them from the catalog variant, @ai-sdk/anthropic 3.0.111 serialises them). `none`
// disables thinking and sends no effort.
function anthropicVariantParams(effort: string | null): Record<string, unknown> {
  if (effort === null) return {};
  return effort === 'none'
    ? { thinking: { type: 'disabled' } }
    : { thinking: { type: 'adaptive' }, output_config: { effort } };
}

/** The request body for one probe case: template plus the transcript's history up to the cut. */
export function probeRequestBody(input: ProbeRequestInput): Record<string, unknown> {
  const { template, transcript, cutAfterStep } = input;
  const task = promptText(transcript);
  const steps = transcript.session.steps.slice(0, cutAfterStep);
  const variantParams =
    template.endpoint === 'anthropic'
      ? anthropicVariantParams(input.effort)
      : template.variantParams;
  const params = mergeDeep(
    template.params,
    input.effort !== null && variantParams !== null
      ? (fillEffort(variantParams, input.effort) as Record<string, unknown>)
      : {}
  );
  const prompt = fillPrompt(template.systemPrompt, input.model, input.today);

  if (template.endpoint === 'anthropic') {
    const messages: unknown[] = [{ role: 'user', content: [{ type: 'text', text: task }] }];
    steps.forEach((step, stepIndex) => {
      const blocks: unknown[] = [];
      if (step.text !== undefined && step.text.length > 0) {
        blocks.push({ type: 'text', text: step.text });
      }
      step.calls.forEach((call, callIndex) => {
        blocks.push({
          type: 'tool_use',
          id: callId(stepIndex, callIndex),
          name: call.tool,
          input: JSON.parse(callArguments(call.command, call.description)) as unknown,
          ...template.toolBlockParams,
        });
      });
      messages.push({ role: 'assistant', content: blocks });
      messages.push({
        role: 'user',
        content: step.calls.map((call, callIndex) => ({
          type: 'tool_result',
          tool_use_id: callId(stepIndex, callIndex),
          content: call.output,
          ...template.toolBlockParams,
        })),
      });
    });
    return {
      model: input.model,
      system: template.systemParts
        ? [{ type: 'text', text: prompt, ...template.systemPartParams }]
        : prompt,
      messages,
      tools: template.tools,
      ...params,
    };
  }

  if (template.endpoint === 'responses') {
    const items: unknown[] = [
      {
        role: template.systemRole,
        content: template.systemParts
          ? [{ type: 'input_text', text: prompt, ...template.systemPartParams }]
          : prompt,
      },
    ];
    items.push({ role: 'user', content: [{ type: 'input_text', text: task }] });
    steps.forEach((step, stepIndex) => {
      if (step.text !== undefined && step.text.length > 0) {
        items.push({ role: 'assistant', content: [{ type: 'output_text', text: step.text }] });
      }
      step.calls.forEach((call, callIndex) => {
        items.push({
          type: 'function_call',
          call_id: callId(stepIndex, callIndex),
          name: call.tool,
          arguments: callArguments(call.command, call.description),
        });
      });
      step.calls.forEach((call, callIndex) => {
        items.push({
          type: 'function_call_output',
          call_id: callId(stepIndex, callIndex),
          output: call.output,
        });
      });
    });
    return {
      model: input.model,
      input: items,
      tools: template.tools,
      ...params,
    };
  }

  const messages: unknown[] = [
    {
      role: template.systemRole,
      content: template.systemParts
        ? [{ type: 'text', text: prompt, ...template.systemPartParams }]
        : prompt,
    },
    { role: 'user', content: [{ type: 'text', text: task }] },
  ];
  steps.forEach((step, stepIndex) => {
    messages.push({
      role: 'assistant',
      content: step.text ?? '',
      tool_calls: step.calls.map((call, callIndex) => ({
        id: callId(stepIndex, callIndex),
        type: 'function',
        function: { name: call.tool, arguments: callArguments(call.command, call.description) },
      })),
    });
    step.calls.forEach((call, callIndex) => {
      messages.push({
        role: 'tool',
        tool_call_id: callId(stepIndex, callIndex),
        content: call.output,
        name: call.tool,
      });
    });
  });
  return {
    model: input.model,
    messages,
    tools: template.tools,
    ...(template.sendsDescription && input.description !== null
      ? { description: input.description }
      : {}),
    ...params,
  };
}
