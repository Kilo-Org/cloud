import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parsePreparedPromptArtifact, renderLivePrompt } from '../../scripts/render-live-prompt';
import { MAX_REVIEW_PROMPT_CHARACTERS } from '../../src/types';

const snapshot = {
  headSha: 'a'.repeat(40),
  baseTipSha: 'b'.repeat(40),
  mergeBaseSha: 'c'.repeat(40),
};
const expected = { owner: 'acme', repo: 'widget', pullNumber: 42, headSha: snapshot.headSha };
const userPrompt =
  '  Canonical prepared artifact: resolved policy, runtime adapter, and captured snapshot.\n';
const artifact = {
  ...expected,
  ...snapshot,
  model: 'kilo-auto/efficient',
  dryRun: true,
  userPrompt,
  expectedIntegrationId: 'fixture-integration',
  expectedInstallationId: 'fixture-installation',
  expectedAppType: 'standard',
  preparation: {
    version: 1,
    preparedAt: '2026-08-27T09:00:00.000Z',
    requestingUserId: 'fixture-user',
    executionUserId: 'fixture-user',
    settings: {
      reviewStyle: 'strict',
      focusAreas: ['authorization', 'correctness'],
      customInstructions: 'Saved instruction fixture',
      manualInstructions: 'Additive instruction fixture',
      model: 'kilo-auto/efficient',
      thinkingEffort: null,
      modelSource: 'explicit',
      disableReviewMd: true,
      analyticsEnabled: false,
    },
    snapshot,
    github: {
      integrationId: 'fixture-integration',
      installationId: 'fixture-installation',
      appType: 'standard',
    },
    hashes: {
      settings: 'd'.repeat(64),
      context: 'e'.repeat(64),
      canonicalPrompt: 'f'.repeat(64),
      adaptedPrompt: createHash('sha256').update(userPrompt).digest('hex'),
      system: '1'.repeat(64),
    },
    versions: { cli: '7.4.20', policy: 'canonical-fixture', adapter: 'isolate-runtime-v1' },
    limitations: [],
  },
};

describe('canonical prepared prompt artifacts', () => {
  it('returns the artifact verbatim instead of reconstructing policy or adding a fake review identity', () => {
    expect(renderLivePrompt(expected, JSON.parse(JSON.stringify(artifact)))).toBe(userPrompt);
    expect(parsePreparedPromptArtifact(artifact).preparation).toEqual(artifact.preparation);
    expect(renderLivePrompt(expected, artifact)).not.toContain('cloud-agent-fork/review/');
    expect(renderLivePrompt(expected, artifact)).not.toContain('e2e00000');
    expect(renderLivePrompt(expected, artifact)).not.toContain('RAW / DEFAULT REVIEW POLICY');
  });

  it('requires the prepared artifact rather than falling back to the old template', () => {
    expect(() => renderLivePrompt(expected)).toThrow('canonical prepared request artifact');
    expect(() => renderLivePrompt(expected, { systemRole: 'Reconstructed template' })).toThrow(
      'request contract'
    );
    expect(() => renderLivePrompt(expected, { ...expected, userPrompt })).toThrow(
      'canonical prepared prompt artifact is required'
    );
  });

  it.each([{ owner: 'other' }, { repo: 'other' }, { pullNumber: 43 }, { headSha: 'd'.repeat(40) }])(
    'rejects an artifact for a different fixture: %j',
    changed => {
      expect(() => renderLivePrompt({ ...expected, ...changed }, artifact)).toThrow(
        'does not match the fixture'
      );
    }
  );

  it('accepts case-insensitive GitHub repository identity without changing artifact bytes', () => {
    expect(renderLivePrompt({ ...expected, owner: 'ACME', repo: 'Widget' }, artifact)).toBe(
      userPrompt
    );
  });

  it('rejects changed prompt bytes or contradictory captured metadata', () => {
    expect(() =>
      renderLivePrompt(expected, { ...artifact, userPrompt: `${userPrompt}changed` })
    ).toThrow('adapted prompt hash');
    expect(() => parsePreparedPromptArtifact({ ...artifact, baseTipSha: 'd'.repeat(40) })).toThrow(
      'request contract'
    );
    expect(() =>
      parsePreparedPromptArtifact({ ...artifact, expectedInstallationId: 'other' })
    ).toThrow('request contract');
  });

  it.each(['gitToken', 'kiloToken', 'Authorization', 'userId'])(
    'rejects credentials or caller identity in an artifact: %s',
    field => {
      expect(() =>
        parsePreparedPromptArtifact({ ...artifact, [field]: 'secret-fixture-value' })
      ).toThrow();
      try {
        parsePreparedPromptArtifact({ ...artifact, [field]: 'secret-fixture-value' });
      } catch (error) {
        expect(error instanceof Error && error.message).not.toContain('secret-fixture-value');
      }
    }
  );

  it('enforces the existing prompt budget without silent clipping', () => {
    const maximumPrompt = 'x'.repeat(MAX_REVIEW_PROMPT_CHARACTERS);
    const maximum = {
      ...artifact,
      userPrompt: maximumPrompt,
      preparation: {
        ...artifact.preparation,
        hashes: {
          ...artifact.preparation.hashes,
          adaptedPrompt: createHash('sha256').update(maximumPrompt).digest('hex'),
        },
      },
    };
    expect(renderLivePrompt(expected, maximum)).toBe(maximumPrompt);
    expect(() =>
      renderLivePrompt(expected, { ...maximum, userPrompt: `${maximumPrompt}x` })
    ).toThrow('request contract');
  });
});
