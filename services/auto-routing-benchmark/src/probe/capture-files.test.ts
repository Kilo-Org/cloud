import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureFileName, writeProbeCaptureFiles } from './capture-files';
import {
  PROBE_TEMPLATES,
  ProbeTemplatesSchema,
  type ProbeTemplate,
  type ProbeTemplates,
} from './request';

const chatTemplate = PROBE_TEMPLATES.families['default/chat'];
const kimiTemplate = PROBE_TEMPLATES.families['kimi/chat'];
if (!chatTemplate || !kimiTemplate) throw new Error('fixtures lack the capture families');

const template = (representative: string): ProbeTemplate => ({
  ...chatTemplate,
  representative: { model: representative, variant: null, effort: null },
});

const UNSUPPORTED_REASON = 'no catalog member is served by the CLI';

/** A datasets directory holding the templates and the captures a previous capture wrote. */
function datasetDir(templates: ProbeTemplates) {
  const out = mkdtempSync(join(tmpdir(), 'probe-captures-'));
  mkdirSync(join(out, 'probe-captures'), { recursive: true });
  writeFileSync(join(out, 'probe-templates.json'), `${JSON.stringify(templates, null, 2)}\n`);
  for (const family of ['default/chat', 'kimi/chat']) {
    writeFileSync(
      join(out, 'probe-captures', captureFileName(family)),
      `${JSON.stringify({ cliVersion: '7.8.27', family }, null, 2)}\n`
    );
  }
  return { out, capturesDir: join(out, 'probe-captures') };
}

describe('probe capture files', () => {
  it('removes the capture of a scoped family that came back unsupported', () => {
    const existing = ProbeTemplatesSchema.parse({
      cliVersion: '7.8.27',
      families: { 'default/chat': template('openai/gpt-6-luna'), 'kimi/chat': kimiTemplate },
      unsupportedFamilies: {},
    });
    const { out, capturesDir } = datasetDir(existing);
    const other = readFileSync(join(capturesDir, 'default--chat.json'), 'utf8');
    expect(readdirSync(capturesDir).toSorted()).toEqual(['default--chat.json', 'kimi--chat.json']);
    const captured = ProbeTemplatesSchema.parse({
      cliVersion: '7.8.27',
      families: {},
      unsupportedFamilies: { 'kimi/chat': UNSUPPORTED_REASON },
    });

    const result = writeProbeCaptureFiles({
      out,
      cliVersion: '7.8.27',
      existing,
      captured,
      scope: ['kimi/chat'],
      captures: {},
    });

    expect(result.removedFiles).toEqual(['kimi--chat.json']);
    expect(() => readFileSync(join(capturesDir, 'kimi--chat.json'), 'utf8')).toThrow();
    expect(result.templates.families['kimi/chat']).toBeUndefined();
    expect(result.templates.unsupportedFamilies).toEqual({ 'kimi/chat': UNSUPPORTED_REASON });
    // Every family the run did not select stays exactly as the directory had it.
    expect(result.templates.families['default/chat']).toEqual(existing.families['default/chat']);
    expect(readFileSync(join(capturesDir, 'default--chat.json'), 'utf8')).toBe(other);
    expect(
      ProbeTemplatesSchema.parse(
        JSON.parse(readFileSync(join(out, 'probe-templates.json'), 'utf8'))
      )
    ).toEqual(result.templates);
  });

  it('leaves an already unsupported family the run did not select alone', () => {
    const existing = ProbeTemplatesSchema.parse({
      cliVersion: '7.8.27',
      families: { 'default/chat': chatTemplate },
      unsupportedFamilies: { 'kimi/chat': UNSUPPORTED_REASON },
    });
    const { out, capturesDir } = datasetDir(existing);
    const stale = readFileSync(join(capturesDir, 'kimi--chat.json'), 'utf8');
    const captured = ProbeTemplatesSchema.parse({
      cliVersion: '7.8.27',
      families: { 'default/chat': template('inclusionai/ling-3.1-flash') },
      unsupportedFamilies: { 'kimi/chat': 'this run would record another reason' },
    });

    const result = writeProbeCaptureFiles({
      out,
      cliVersion: '7.8.27',
      existing,
      captured,
      scope: ['default/chat'],
      captures: { 'default/chat': { family: 'default/chat' } },
    });

    expect(result.removedFiles).toEqual([]);
    expect(readFileSync(join(capturesDir, 'kimi--chat.json'), 'utf8')).toBe(stale);
    expect(result.templates.unsupportedFamilies).toEqual({ 'kimi/chat': UNSUPPORTED_REASON });
    expect(result.templates.families['default/chat']?.representative.model).toBe(
      'inclusionai/ling-3.1-flash'
    );
  });

  it('sweeps a full run of every capture no template backs', () => {
    const { out, capturesDir } = datasetDir({
      cliVersion: '7.8.27',
      families: { 'default/chat': chatTemplate, 'kimi/chat': kimiTemplate },
      unsupportedFamilies: {},
    });
    const captured = ProbeTemplatesSchema.parse({
      cliVersion: '7.8.27',
      families: { 'default/chat': template('openai/gpt-6-luna') },
      unsupportedFamilies: { 'kimi/chat': UNSUPPORTED_REASON },
    });

    const result = writeProbeCaptureFiles({
      out,
      cliVersion: '7.8.27',
      captured,
      scope: [],
      captures: { 'default/chat': { family: 'default/chat' } },
    });

    expect(result.removedFiles).toEqual(['kimi--chat.json']);
    expect(readdirSync(capturesDir)).toEqual(['default--chat.json']);
    expect(result.templates).toEqual(captured);
  });
});
