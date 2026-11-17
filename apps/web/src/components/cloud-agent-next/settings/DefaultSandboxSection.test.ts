import { describe, expect, it, jest } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CloudAgentSettingsData } from '@/hooks/useCloudAgentSettings';

jest.mock('@/hooks/useCloudAgentSettings', () => ({
  useSetContextAllocationMutation: () => ({ isPending: false, mutate: jest.fn() }),
}));

jest.mock('./SandboxSelect', () => ({
  SandboxSelect: () => createElement('div', null, 'Sandbox options loaded'),
}));

Object.assign(globalThis, { React });

describe('DefaultSandboxSection eligibility failure', () => {
  it('preserves the saved size and offers retry without claiming it will fall back', async () => {
    const { DefaultSandboxSection } = await import('./DefaultSandboxSection');
    const settings: CloudAgentSettingsData = {
      canManage: true,
      contextAllocation: 'cloudflare-containers-standard-4',
      builtinAgents: {},
      repositories: [],
      capabilities: null,
      capabilitiesByPlatform: { github: null, gitlab: null },
    };
    const render = (data: CloudAgentSettingsData) =>
      renderToStaticMarkup(
        createElement(DefaultSandboxSection, {
          settings: data,
          onRetry: jest.fn(),
        })
      );

    const failed = render(settings);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Could not load sandbox options. Saved settings have not changed.');
    expect(failed).toContain('cloudflare-containers-standard-4');
    expect(failed).toContain('Retry sandbox options');
    expect(failed).not.toContain('next available default');
    expect(failed).not.toContain('Sandbox options loaded');

    const recovered = render({ ...settings, capabilities: { enabled: true, options: [] } });
    expect(recovered).toContain('Sandbox options loaded');
    expect(recovered).not.toContain('Retry sandbox options');
  });
});
