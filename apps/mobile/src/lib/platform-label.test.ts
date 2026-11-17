import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { isUnknownOrigin, platformLabel } from '@/lib/platform-label';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('platformLabel', () => {
  it('maps cloud-agent and cloud-agent-web to CLOUD AGENT', () => {
    expect(platformLabel('cloud-agent')).toBe('CLOUD AGENT');
    expect(platformLabel('cloud-agent-web')).toBe('CLOUD AGENT');
  });

  it('maps vscode and agent-manager to VSCODE', () => {
    expect(platformLabel('vscode')).toBe('VSCODE');
    expect(platformLabel('agent-manager')).toBe('VSCODE');
  });

  it('maps slack to SLACK', () => {
    expect(platformLabel('slack')).toBe('SLACK');
  });

  it('maps cli to CLI — the kilo remote spawn label fix', () => {
    expect(platformLabel('cli')).toBe('CLI');
  });

  it('falls back to an uppercased passthrough for unknown platforms', () => {
    expect(platformLabel('some-future-platform')).toBe('SOME-FUTURE-PLATFORM');
  });

  it('uppercases an unknown platform with the active locale (Turkish i → İ)', async () => {
    await i18n.changeLanguage('tr');
    expect(platformLabel('instance')).toBe('İNSTANCE');
  });
  it('names the unknown origin for an absent platform instead of a live status', () => {
    const neutral = i18n.t('common.unknown');
    expect(platformLabel(null)).toBe(neutral);
    expect(platformLabel(undefined)).toBe(neutral);
    expect(platformLabel('')).toBe(neutral);
    expect(platformLabel(null)).not.toBe(i18n.t('agents.sessionList.live'));
  });

  it("names the unknown origin for the backend's unknown sentinel", () => {
    expect(platformLabel('unknown')).toBe(i18n.t('common.unknown'));
  });

  it('keeps the neutral origin label translatable', async () => {
    await i18n.changeLanguage('de');
    expect(platformLabel(undefined)).toBe(i18n.t('common.unknown'));
    expect(platformLabel('unknown')).toBe(i18n.t('common.unknown'));
  });

  it('classifies unrecorded origins for the tint without label text', () => {
    for (const origin of [null, undefined, '', 'unknown']) {
      expect(isUnknownOrigin(origin)).toBe(true);
    }
    for (const origin of ['cli', 'cloud-agent-web', 'some-future-platform']) {
      expect(isUnknownOrigin(origin)).toBe(false);
    }
  });
});
