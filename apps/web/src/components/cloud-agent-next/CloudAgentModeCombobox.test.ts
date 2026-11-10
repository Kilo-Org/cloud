import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BuiltinAgentSettings } from '@kilocode/cloud-agent-profile';
import { CloudAgentModeCombobox } from './CloudAgentModeCombobox';

let mockAgents: BuiltinAgentSettings | undefined;
let mockIsLoading = false;

jest.mock('@/hooks/useCloudAgentSettings', () => ({
  useBuiltinAgentSettings: () => ({ data: mockAgents, isLoading: mockIsLoading }),
}));

jest.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => children,
  PopoverContent: ({ children }: { children: React.ReactNode }) => children,
}));

const previousReact = Reflect.get(globalThis, 'React');
beforeAll(() => Object.assign(globalThis, { React }));
afterAll(() => {
  if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
  else Object.assign(globalThis, { React: previousReact });
});
beforeEach(() => {
  mockAgents = {};
  mockIsLoading = false;
});

describe.each(['compact', 'full'] as const)('CloudAgentModeCombobox (%s)', variant => {
  function render(value = 'code') {
    return renderToStaticMarkup(
      createElement(CloudAgentModeCombobox, {
        value,
        variant,
        onValueChange: () => {},
        customOptions: [{ value: 'reviewer', label: 'Reviewer', description: 'Review changes' }],
      })
    );
  }

  it('hides disabled built-in modes while keeping Code and custom modes', () => {
    mockAgents = {
      plan: { disable: true },
      debug: { disable: true },
      orchestrator: { disable: true },
      ask: { disable: true },
    };

    const html = render();
    expect(html).toContain('Code');
    expect(html).toContain('Reviewer');
    for (const label of ['Plan', 'Debug', 'Orchestrator', 'Ask']) {
      expect(html).not.toContain(`>${label}<`);
    }
  });

  it('keeps modes with model overrides or an explicit disable: false', () => {
    mockAgents = {
      plan: { model: 'test/model' },
      debug: { disable: false },
      explore: { model: 'test/background' },
    };

    const html = render();
    for (const label of ['Code', 'Plan', 'Debug', 'Orchestrator', 'Ask']) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).not.toContain('Explore');
  });

  it('reflects saved visibility changes without replacing the selected mode', () => {
    expect(render()).toContain('>Plan<');
    mockAgents = { plan: { disable: true } };
    const html = render('plan');
    expect(html).not.toContain('>Plan<');
    expect(html).toContain('>plan<');
    mockAgents = {};
    expect(render()).toContain('>Plan<');
  });

  it('does not offer unfiltered modes while preferences load', () => {
    mockAgents = undefined;
    mockIsLoading = true;

    const html = render();
    expect(html).not.toContain('>Plan<');
    expect(html).not.toContain('>Reviewer<');
  });
});
