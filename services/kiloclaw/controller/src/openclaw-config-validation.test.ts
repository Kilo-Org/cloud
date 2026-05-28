import { describe, expect, it, vi } from 'vitest';
import {
  type OpenclawConfigValidationDeps,
  validateOpenclawConfigCandidate,
} from './openclaw-config-validation';

const CONFIG_PATH = '/root/.openclaw/openclaw.json';
const STAGE_PATH = '/root/.openclaw/.openclaw.kiloclaw-validation-candidate.json';

function createDeps(stdout: string, timedOut = false): OpenclawConfigValidationDeps {
  return {
    readCandidate: vi.fn().mockReturnValue('{"gateway":{"mode":"local"}}'),
    removeFile: vi.fn(),
    writeCandidate: vi.fn(),
    runValidation: vi.fn().mockResolvedValue({ stdout, timedOut }),
  };
}

describe('validateOpenclawConfigCandidate', () => {
  it('validates a staged candidate and removes the stage file', async () => {
    const deps = createDeps(JSON.stringify({ valid: true, path: STAGE_PATH }));

    await expect(
      validateOpenclawConfigCandidate('{"gateway":{"mode":"local"}}', CONFIG_PATH, deps)
    ).resolves.toEqual({ valid: true });

    expect(deps.writeCandidate).toHaveBeenCalledWith(STAGE_PATH, '{"gateway":{"mode":"local"}}');
    expect(deps.runValidation).toHaveBeenCalledWith(STAGE_PATH);
    expect(deps.removeFile).toHaveBeenNthCalledWith(1, STAGE_PATH);
    expect(deps.removeFile).toHaveBeenNthCalledWith(2, `${STAGE_PATH}.bak`);
    expect(deps.removeFile).toHaveBeenNthCalledWith(3, STAGE_PATH);
    expect(deps.removeFile).toHaveBeenNthCalledWith(4, `${STAGE_PATH}.bak`);
  });

  it('returns bounded issues from invalid OpenClaw validation', async () => {
    const deps = createDeps(
      JSON.stringify({
        valid: false,
        issues: [
          { path: 'gateway.mode', message: 'Unknown mode\nuse local', allowedValues: ['local'] },
        ],
      })
    );

    await expect(validateOpenclawConfigCandidate('{}', CONFIG_PATH, deps)).resolves.toEqual({
      valid: false,
      reason: 'invalid',
      issues: [
        { path: 'gateway.mode', message: 'Unknown mode use local', allowedValues: ['local'] },
      ],
    });
  });

  it('returns validation-unavailable when validation times out or output is unreadable', async () => {
    const timeoutDeps = createDeps('', true);
    await expect(validateOpenclawConfigCandidate('{}', CONFIG_PATH, timeoutDeps)).resolves.toEqual({
      valid: false,
      reason: 'validation-unavailable',
      issues: [{ path: '', message: 'OpenClaw configuration validation timed out.' }],
    });

    const malformedDeps = createDeps('not json');
    await expect(
      validateOpenclawConfigCandidate('{}', CONFIG_PATH, malformedDeps)
    ).resolves.toEqual({
      valid: false,
      reason: 'validation-unavailable',
      issues: [
        { path: '', message: 'OpenClaw configuration validation returned an unreadable result.' },
      ],
    });
  });

  it('logs safe failure metadata when staging fails unexpectedly', async () => {
    const deps = createDeps(JSON.stringify({ valid: true }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(deps.writeCandidate).mockImplementation(() => {
      throw Object.assign(new Error('disk full at a sensitive path'), { code: 'ENOSPC' });
    });

    await expect(validateOpenclawConfigCandidate('{}', CONFIG_PATH, deps)).resolves.toEqual({
      valid: false,
      reason: 'validation-unavailable',
      issues: [
        { path: '', message: 'There is not enough disk space to validate this configuration.' },
      ],
    });
    expect(log).toHaveBeenCalledWith(
      '[openclaw-config-validation] Validation failed unexpectedly:',
      'ENOSPC'
    );
    expect(log.mock.calls.flat().join(' ')).not.toContain('sensitive path');

    log.mockRestore();
  });

  it.each([
    ['EACCES', 'OpenClaw cannot access the temporary validation file.'],
    ['EPERM', 'OpenClaw cannot access the temporary validation file.'],
    ['EEXIST', 'Configuration validation is already in progress. Try saving again.'],
  ])('returns actionable messages for staging error %s', async (code, message) => {
    const deps = createDeps(JSON.stringify({ valid: true }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(deps.writeCandidate).mockImplementation(() => {
      throw Object.assign(new Error('staging failed'), { code });
    });

    await expect(validateOpenclawConfigCandidate('{}', CONFIG_PATH, deps)).resolves.toEqual({
      valid: false,
      reason: 'validation-unavailable',
      issues: [{ path: '', message }],
    });
    log.mockRestore();
  });

  it('redacts staging filenames from invalid diagnostics', async () => {
    const deps = createDeps(
      JSON.stringify({
        valid: false,
        issues: [{ path: STAGE_PATH, message: `Invalid include: ${STAGE_PATH}` }],
      })
    );

    await expect(validateOpenclawConfigCandidate('{}', CONFIG_PATH, deps)).resolves.toEqual({
      valid: false,
      reason: 'invalid',
      issues: [{ path: 'openclaw.json', message: 'Invalid include: openclaw.json' }],
    });
  });

  it('warns if the staged bytes changed after successful validation', async () => {
    const deps = createDeps(JSON.stringify({ valid: true }));
    vi.mocked(deps.readCandidate).mockReturnValue('{"other":true}');

    await expect(
      validateOpenclawConfigCandidate('{"gateway":{"mode":"local"}}', CONFIG_PATH, deps)
    ).resolves.toEqual({
      valid: false,
      reason: 'validation-unavailable',
      issues: [{ path: '', message: 'OpenClaw configuration changed during validation.' }],
    });
  });

  it('warns without staging a strict-JSON self-targeting include', async () => {
    const deps = createDeps(JSON.stringify({ valid: true }));
    const candidate = JSON.stringify({ agents: { $include: './openclaw.json' } });

    await expect(validateOpenclawConfigCandidate(candidate, CONFIG_PATH, deps)).resolves.toEqual({
      valid: false,
      reason: 'validation-unavailable',
      issues: [
        {
          path: '',
          message:
            'This config includes openclaw.json itself, so it cannot be validated safely before saving.',
        },
      ],
    });
    expect(deps.writeCandidate).not.toHaveBeenCalled();
    expect(deps.runValidation).not.toHaveBeenCalled();
  });

  it('inspects deeply nested candidates without recursive traversal', async () => {
    const deps = createDeps(JSON.stringify({ valid: true }));
    const depth = 10_000;
    const candidate = `${'{"nested":'.repeat(depth)}{"$include":"./openclaw.json"}${'}'.repeat(depth)}`;

    await expect(
      validateOpenclawConfigCandidate(candidate, CONFIG_PATH, deps)
    ).resolves.toMatchObject({
      valid: false,
      reason: 'validation-unavailable',
    });
    expect(deps.writeCandidate).not.toHaveBeenCalled();
  });

  it('warns without staging JSON5 candidates, including escaped self-targeting includes', async () => {
    for (const candidate of [
      "{ agents: { $include: './openclaw.json' } }",
      "{ '$incl\\u0075de': './openclaw.json' }",
    ]) {
      const deps = createDeps(JSON.stringify({ valid: true }));
      await expect(validateOpenclawConfigCandidate(candidate, CONFIG_PATH, deps)).resolves.toEqual({
        valid: false,
        reason: 'validation-unavailable',
        issues: [
          {
            path: '',
            message:
              'This save path validates strict JSON only. Convert JSON5 syntax before saving.',
          },
        ],
      });
      expect(deps.writeCandidate).not.toHaveBeenCalled();
      expect(deps.runValidation).not.toHaveBeenCalled();
    }
  });
});
