import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { platformLabel } from '@/lib/platform-label';

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
});
