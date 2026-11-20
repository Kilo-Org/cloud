import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { PROBE_CASES, probeCaseId } from '../datasets/probe-cases';
import { comparableBody } from './body-compare';
import { probePromptId } from './family';
import { PROBE_TEMPLATES, probeRequestBody } from './request';

// The gateway pilot sent real requests from the pinned CLI 7.8.27 to the gateway the probe
// posts to. This file reproduces two of them from the fixtures: one Responses pair
// (meta/muse-ember) and one chat pair (deepseek/deepseek-v4.1-flash-1017), so a builder
// change or a CLI bump that alters the request fails here.

const CaptureSchema = z.object({
  model: z.string().min(1),
  variant: z.string().nullable(),
  caseId: z.string().min(1),
  cutAfterStep: z.number().int().positive(),
  endpoint: z.enum(['chat', 'responses']),
  today: z.string().min(1),
  body: z.record(z.string(), z.unknown()),
});

const FixtureSchema = z.object({
  cliVersion: z.string().min(1),
  cases: z.array(CaptureSchema),
});

type Capture = z.infer<typeof CaptureSchema>;

const fixture = FixtureSchema.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, 'pilot-captures.json'), 'utf8'))
);

function builtBody(capture: Capture): Record<string, unknown> {
  const benchCase = PROBE_CASES.find(
    entry => entry.id === probeCaseId(capture.caseId, capture.cutAfterStep)
  );
  if (!benchCase) throw new Error(`no probe case ${capture.caseId} at ${capture.cutAfterStep}`);
  const reasoning = z
    .object({ effort: z.string().min(1) })
    .nullish()
    .parse(capture.body.reasoning);
  const template =
    PROBE_TEMPLATES.families[`${probePromptId({ id: capture.model })}/${capture.endpoint}`];
  if (!template) throw new Error(`no template for ${capture.model} on ${capture.endpoint}`);
  return probeRequestBody({
    template,
    model: capture.model,
    description: typeof capture.body.description === 'string' ? capture.body.description : null,
    effort: reasoning?.effort ?? null,
    transcript: benchCase.probe.transcript,
    cutAfterStep: capture.cutAfterStep,
    today: capture.today,
  });
}

describe('probe request against the gateway pilot', () => {
  it('captured with the pinned CLI version', () => {
    expect(PROBE_TEMPLATES.cliVersion).toBe(fixture.cliVersion);
  });

  it('covers a Responses pair and a chat pair', () => {
    const endpoints = new Set(fixture.cases.map(capture => capture.endpoint));
    expect([...endpoints].sort()).toEqual(['chat', 'responses']);
  });

  it.each(
    fixture.cases.map(
      capture => [`${capture.model} ${capture.variant ?? 'no variant'}`, capture] as const
    )
  )('reproduces the pilot request for %s', (_name, capture) => {
    expect(comparableBody(builtBody(capture))).toEqual(comparableBody(capture.body));
  });
});
