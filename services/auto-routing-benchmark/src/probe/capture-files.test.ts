import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureFileName, writeProbeCaptureFiles } from './capture-files';
import { ProbeTemplatesSchema, type ProbeTemplate, type ProbeTemplates } from './request';

/** The smallest template `writeProbeCaptureFiles` and the templates schema accept. */
const template = (model: string): ProbeTemplate => ({
  endpoint: 'chat',
  tools: [{ type: 'function', function: { name: 'probe', parameters: { type: 'object' } } }],
  systemRole: 'system',
  systemPrompt: 'You are a probe request.\n{{MODEL_ID}}',
  systemParts: false,
  systemPartParams: {},
  toolBlockParams: {},
  params: { temperature: 0 },
  variantParams: null,
  sendsDescription: true,
  headers: {},
  representative: { model, variant: null, effort: null },
});

const UNSUPPORTED_REASON = 'no catalog member is served by the CLI';

const tempDirs: string[] = [];

/** Removes every temp dir this file created; also the body of `afterEach`. */
function removeTempDirs() {
  for (const out of tempDirs.splice(0)) rmSync(out, { recursive: true, force: true });
}

/** A datasets directory holding the templates and the captures a previous capture wrote. */
function datasetDir(templates: ProbeTemplates) {
  const out = mkdtempSync(join(tmpdir(), 'probe-captures-'));
  tempDirs.push(out);
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

afterEach(removeTempDirs);

describe('probe capture files', () => {
  it('removes the capture of a scoped family that came back unsupported', () => {
    const existing = ProbeTemplatesSchema.parse({
      cliVersion: '7.8.27',
      families: {
        'default/chat': template('openai/gpt-6-luna'),
        'kimi/chat': template('moonshot/k3'),
      },
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
    // The temp dir exists until the shared cleanup (the `afterEach` body) removes it.
    expect(existsSync(out)).toBe(true);
    removeTempDirs();
    expect(existsSync(out)).toBe(false);
  });

  it('leaves an already unsupported family the run did not select alone', () => {
    const existing = ProbeTemplatesSchema.parse({
      cliVersion: '7.8.27',
      families: { 'default/chat': template('openai/gpt-6-luna') },
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
      families: {
        'default/chat': template('openai/gpt-6-luna'),
        'kimi/chat': template('moonshot/k3'),
      },
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
