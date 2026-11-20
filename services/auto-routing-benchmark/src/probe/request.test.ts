import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import type { ProbeTranscript } from '../datasets/probe-transcripts';
import { comparableBody } from './body-compare';
import { probeEndpoint, probeFamily, probePromptId } from './family';
import {
  PROBE_TEMPLATES,
  ProbeEffortSchema,
  ProbeTemplatesSchema,
  mergeProbeTemplates,
  probeRequestBody,
  probeTemplate,
  type ProbeTemplate,
} from './request';

const CAPTURE_DIR = join(import.meta.dirname, '..', 'datasets', 'probe-captures');

const CaptureSchema = z.object({
  cliVersion: z.string().min(1),
  family: z.string().min(1),
  model: z.string().min(1),
  variant: z.string().nullable(),
  effort: ProbeEffortSchema.nullable(),
  description: z.string().nullable().optional(),
  transcript: z.object({
    systemPrompt: z.string().min(1),
    userPrompt: z.string().min(1),
    session: z.object({
      files: z.record(z.string(), z.string()),
      steps: z.array(
        z.object({
          text: z.string().optional(),
          calls: z.array(
            z.object({
              tool: z.literal('bash'),
              command: z.string(),
              description: z.string(),
              output: z.string(),
            })
          ),
        })
      ),
      message: z.string(),
    }),
  }),
  body: z.record(z.string(), z.unknown()),
});

const captures = readdirSync(CAPTURE_DIR)
  .filter(name => name.endsWith('.json'))
  .map(name => CaptureSchema.parse(JSON.parse(readFileSync(join(CAPTURE_DIR, name), 'utf8'))));

function transcriptOf(capture: z.infer<typeof CaptureSchema>): ProbeTranscript {
  return {
    id: 'capture',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: capture.transcript.systemPrompt,
    userPrompt: capture.transcript.userPrompt,
    check: { kind: 'exact', value: 'probe capture line one' },
    session: {
      files: capture.transcript.session.files,
      steps: capture.transcript.session.steps.map(step => ({
        ...(step.text === undefined ? {} : { text: step.text }),
        calls: step.calls,
      })),
      message: capture.transcript.session.message,
    },
  };
}

describe('probe request builder', () => {
  it('captured at least the prompt families the pool needs', () => {
    expect(captures.length).toBeGreaterThan(0);
    for (const capture of captures) {
      expect(PROBE_TEMPLATES.families[capture.family], capture.family).toBeDefined();
    }
    expect(PROBE_TEMPLATES.cliVersion).toBe('7.8.27');
  });

  it.each(captures.map(capture => [capture.family, capture] as const))(
    'reproduces the %s capture from its template',
    (_key, capture) => {
      const template = PROBE_TEMPLATES.families[capture.family] as ProbeTemplate;
      const transcript = transcriptOf(capture);
      const built = probeRequestBody({
        template,
        model: '{{MODEL_ID}}',
        description: capture.description ?? null,
        effort: capture.effort,
        transcript,
        cutAfterStep: transcript.session.steps.length,
        today: '{{TODAY}}',
      });
      expect(comparableBody({ ...built, tools: '{{TOOLS}}' })).toEqual(
        comparableBody(capture.body)
      );
    }
  );

  it('ends every probe history on the captured tool result, never on a user message', () => {
    for (const capture of captures) {
      const body = capture.body;
      if (Array.isArray(body.messages)) {
        const last = z.record(z.string(), z.unknown()).parse((body.messages as unknown[]).at(-1));
        if (last.role === 'user') {
          // Messages answers a tool call with a tool_result block in a user turn.
          const block = z.record(z.string(), z.unknown()).parse((last.content as unknown[])[0]);
          expect(block.type).toBe('tool_result');
          expect(String(block.content).length).toBeGreaterThan(0);
        } else {
          expect(last.role).toBe('tool');
        }
      } else {
        const last = z.record(z.string(), z.unknown()).parse((body.input as unknown[]).at(-1));
        expect(last.type).toBe('function_call_output');
      }
    }
  });

  it('captures each family once, with the endpoint the family key names', () => {
    const keys = captures.map(capture => capture.family);
    expect(new Set(keys).size).toBe(keys.length);
    for (const capture of captures) {
      expect(
        capture.family.endsWith(`/${PROBE_TEMPLATES.families[capture.family]?.endpoint}`)
      ).toBe(true);
    }
  });
});

describe('probe family selection', () => {
  it.each([
    ['meta/muse-ember', 'openai', 'meta/responses'],
    ['meta/muse-spark-1.2-contributor', 'openai', 'meta/responses'],
    ['deepseek/deepseek-v4.1-flash-1017', undefined, 'default/chat'],
    ['openai/gpt-5.6-sol', 'openai', 'gpt/responses'],
    ['openai/gpt-4o-mini', 'openai', 'beast/responses'],
    ['openai/gpt-5.2-codex', 'openai', 'codex/responses'],
    ['google/gemini-3.1-flash-lite', undefined, 'gemini/chat'],
    ['anthropic/claude-opus-5', 'anthropic', 'anthropic/anthropic'],
    ['moonshotai/kimi-k3', undefined, 'kimi/chat'],
    ['inclusionai/ling-3.0-flash', undefined, 'ling/chat'],
    ['arcee-ai/trinity-large-thinking', undefined, 'trinity/chat'],
  ])('maps %s (ai_sdk_provider %s) to %s', (id, provider, expected) => {
    expect(probeFamily({ id, opencode: { ai_sdk_provider: provider } }).key).toBe(expected);
  });

  it('honours the catalog prompt before the id, as the CLI does', () => {
    expect(probePromptId({ id: 'vendor/unknown', opencode: { prompt: 'gpt55' } })).toBe('gpt55');
    expect(
      probePromptId({ id: 'vendor/unknown', opencode: { prompt: 'anthropic_without_todo' } })
    ).toBe('default');
  });

  it('treats only the anthropic SDK as the Messages API', () => {
    expect(probeEndpoint({ id: 'a/b', opencode: { ai_sdk_provider: 'anthropic' } })).toBe(
      'anthropic'
    );
    for (const provider of ['openai', 'openai-compatible', 'openrouter', undefined]) {
      expect(probeEndpoint({ id: 'a/b', opencode: { ai_sdk_provider: provider } })).not.toBe(
        'anthropic'
      );
    }
  });

  it('reports a family without a template instead of building a request', () => {
    const missing = probeTemplate({
      key: 'unknown/chat',
      promptId: 'default',
      endpoint: 'chat',
    });
    expect(missing).toEqual({
      unsupportedReason: expect.stringContaining('has no captured request template'),
    });
  });

  it('builds a Messages request for the anthropic family', () => {
    const resolved = probeTemplate(
      probeFamily({ id: 'anthropic/claude-opus-5', opencode: { ai_sdk_provider: 'anthropic' } })
    );
    expect('template' in resolved && resolved.template.endpoint).toBe('anthropic');
  });
});

describe('mergeProbeTemplates', () => {
  const responsesTemplate = PROBE_TEMPLATES.families['gpt/responses'];
  const chatTemplate = PROBE_TEMPLATES.families['default/chat'];
  if (!responsesTemplate || !chatTemplate) throw new Error('fixtures lack the merged families');
  const template = (representative: string): ProbeTemplate => ({
    ...chatTemplate,
    representative: { model: representative, variant: null, effort: null },
  });
  const existing = ProbeTemplatesSchema.parse({
    cliVersion: '7.8.27',
    families: {
      'gpt/responses': responsesTemplate,
      'default/chat': chatTemplate,
      'openai/responses': template('openai/gpt-6-luna'),
    },
    unsupportedFamilies: { 'kimi/chat': 'no catalog member is served' },
  });

  it('replaces the captured family and keeps every other family and reason', () => {
    const merged = mergeProbeTemplates(
      existing,
      ProbeTemplatesSchema.parse({
        cliVersion: '7.8.28',
        families: { 'default/chat': template('inclusionai/ling-3.1-flash') },
      }),
      ['default/chat']
    );
    expect(Object.keys(merged.families).toSorted()).toEqual([
      'default/chat',
      'gpt/responses',
      'openai/responses',
    ]);
    expect(merged.families['default/chat']?.representative.model).toBe(
      'inclusionai/ling-3.1-flash'
    );
    expect(merged.families['openai/responses']).toEqual(existing.families['openai/responses']);
    expect(merged.unsupportedFamilies).toEqual({ 'kimi/chat': 'no catalog member is served' });
    expect(merged.cliVersion).toBe('7.8.28');
  });

  it('drops a scoped template when that family captured as unsupported', () => {
    const merged = mergeProbeTemplates(
      existing,
      ProbeTemplatesSchema.parse({
        cliVersion: '7.8.27',
        families: {},
        unsupportedFamilies: {
          'gpt/responses': 'no catalog member is served',
          'kimi/chat': 'outside the scope of this run',
        },
      }),
      ['gpt/responses']
    );
    expect(merged.families['gpt/responses']).toBeUndefined();
    expect(merged.unsupportedFamilies).toEqual({
      'gpt/responses': 'no catalog member is served',
      'kimi/chat': 'no catalog member is served',
    });
  });

  it('clears a scoped unsupported reason when the family captures again', () => {
    const merged = mergeProbeTemplates(
      existing,
      ProbeTemplatesSchema.parse({
        cliVersion: '7.8.27',
        families: { 'kimi/chat': template('moonshotai/kimi-k4') },
      }),
      ['kimi/chat']
    );
    expect(merged.unsupportedFamilies).toEqual({});
    expect(merged.families['kimi/chat']?.representative.model).toBe('moonshotai/kimi-k4');
  });
});
