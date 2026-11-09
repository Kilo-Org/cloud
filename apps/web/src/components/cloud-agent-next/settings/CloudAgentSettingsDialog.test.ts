import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CloudAgentSettingsData } from '@/hooks/useCloudAgentSettings';
import type { CloudAgentSettingsDialog as CloudAgentSettingsDialogComponent } from './CloudAgentSettingsDialog';

const mockUseCloudAgentSettings = jest.fn();

jest.mock('@/hooks/useCloudAgentSettings', () => ({
  useCloudAgentSettings: () => mockUseCloudAgentSettings(),
  useSetBuiltinAgentsMutation: () => ({ isPending: false, mutate: jest.fn() }),
}));

jest.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

jest.mock('@/lib/hooks/use-openrouter-models', () => ({
  useModelSelectorList: () => ({ data: { data: [] }, isLoading: false }),
}));

jest.mock('@/components/shared/ModelCombobox', () => ({
  ModelCombobox: () => createElement('div', { 'data-section': 'model-combobox' }),
}));

jest.mock('@/components/shared/VariantCombobox', () => ({ VariantCombobox: () => null }));

jest.mock('@kilocode/cloud-agent-profile', () => ({
  CLOUD_AGENT_BUILTIN_AGENTS: [
    {
      slug: 'code',
      name: 'Code',
      description: 'Writes code.',
      kind: 'primary',
      canDisable: false,
    },
    {
      slug: 'plan',
      name: 'Plan',
      description: 'Plans work.',
      kind: 'primary',
      canDisable: true,
    },
    {
      slug: 'explore',
      name: 'Explore',
      description: 'Reads the repository.',
      kind: 'subagent',
      canDisable: false,
    },
  ],
}));

jest.mock('@/components/cloud-agent/profile-editor/ProfilesManager', () => ({
  ProfilesManager: () => null,
}));

jest.mock('./DefaultSandboxSection', () => ({
  DefaultSandboxSection: () => createElement('div', null, 'Default sandbox'),
}));

jest.mock('./RepositoryOverridesSection', () => ({
  RepositoryOverridesSection: () => createElement('div', null, 'Repository overrides'),
}));

jest.mock('./EnvironmentsSection', () => ({ EnvironmentsSection: () => null }));

jest.mock('./VercelComputeSettings', () => ({ VercelComputeSettings: () => null }));

jest.mock('@/components/ui/dialog', () => {
  const stub =
    (slot: string) =>
    ({ children }: { children?: React.ReactNode }) =>
      createElement('div', { 'data-slot': slot }, children);
  return {
    Dialog: stub('dialog'),
    DialogContent: stub('dialog-content'),
    DialogHeader: stub('dialog-header'),
    DialogTitle: stub('dialog-title'),
    DialogDescription: stub('dialog-description'),
  };
});

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children?: React.ReactNode }) =>
    createElement('span', { 'data-slot': 'badge' }, children),
}));

let mockTabsOnValueChange: ((value: string) => void) | undefined;

jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({
    children,
    onValueChange,
  }: {
    children?: React.ReactNode;
    onValueChange?: (value: string) => void;
  }) => {
    mockTabsOnValueChange = onValueChange;
    return createElement('div', null, children);
  },
  TabsList: ({ children }: { children?: React.ReactNode }) => createElement('div', null, children),
  TabsTrigger: ({ value, children }: { value: string; children?: React.ReactNode }) =>
    createElement(
      'button',
      { type: 'button', onClick: () => mockTabsOnValueChange?.(value) },
      children
    ),
  TabsContent: ({ value, children }: { value: string; children?: React.ReactNode }) =>
    value === 'general' || value === 'preferences'
      ? createElement('div', { 'data-tab': value }, children)
      : null,
}));

jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) =>
    createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) =>
    createElement(React.Fragment, null, children),
  TooltipContent: () => null,
}));

jest.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) =>
    createElement('button', {
      ...props,
      type: 'button',
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
      onClick: () => onCheckedChange?.(!checked),
    }),
}));

type LinkedomParseHtml = (html: string) => { window: typeof globalThis; document: Document };

const requireFromHere = createRequire(__filename);
const { parseHTML } = requireFromHere('linkedom') as { parseHTML: LinkedomParseHtml };
const { window: domWindow, document: domDocument } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);

class StorageEventStub extends domWindow.Event {
  key: string | null;

  constructor(type: string, init?: { key?: string }) {
    super(type);
    this.key = init?.key ?? null;
  }
}

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string): string | null => storage.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    storage.set(key, String(value));
  },
  removeItem: (key: string): void => {
    storage.delete(key);
  },
  clear: (): void => {
    storage.clear();
  },
};

Object.assign(domWindow, { localStorage: localStorageStub });
Object.assign(globalThis, {
  React,
  window: domWindow,
  document: domDocument,
  HTMLElement: domWindow.HTMLElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  StorageEvent: StorageEventStub,
  localStorage: localStorageStub,
  getComputedStyle: () => ({ animationName: 'none', display: 'block' }),
  IS_REACT_ACT_ENVIRONMENT: true,
});

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { CloudAgentSettingsDialog } = require('./CloudAgentSettingsDialog') as {
  CloudAgentSettingsDialog: typeof CloudAgentSettingsDialogComponent;
};

function settings(canManage: boolean): CloudAgentSettingsData {
  return { canManage, builtinAgents: {} } as CloudAgentSettingsData;
}

function queryResult(result: { data?: CloudAgentSettingsData; isError?: boolean }) {
  return {
    data: result.data,
    isError: result.isError ?? false,
    refetch: jest.fn(),
  };
}

function section(headingId: string): Element {
  const element = domDocument.querySelector(`section[aria-labelledby="${headingId}"]`);
  if (!element) throw new Error(`Missing section ${headingId}`);
  return element;
}

function personalSwitch(): HTMLButtonElement {
  const element = domDocument.querySelector<HTMLButtonElement>('[role="switch"]');
  if (!element) throw new Error('Missing personal preference switch');
  return element;
}

function badgeTexts(): string[] {
  return Array.from(domDocument.querySelectorAll('[data-slot="badge"]')).map(badge =>
    (badge.textContent ?? '').trim()
  );
}

describe('CloudAgentSettingsDialog scope grouping', () => {
  let root: Root;

  beforeEach(() => {
    storage.clear();
    mockUseCloudAgentSettings.mockReset();
    const container = domDocument.getElementById('root');
    if (!container) throw new Error('Missing settings dialog test root');
    act(() => {
      root = createRoot(container);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  function renderDialog(organizationId?: string): void {
    act(() => {
      root.render(
        createElement(CloudAgentSettingsDialog, {
          organizationId,
          open: true,
          onOpenChange: () => undefined,
        })
      );
    });
  }

  it('separates organization settings from personal preferences', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(true) }));
    renderDialog('org-1');

    expect(badgeTexts()).toEqual([
      'Organization workspace',
      'All members',
      'Only you',
      'This browser',
    ]);

    const headings = Array.from(domDocument.querySelectorAll('h3')).map(heading =>
      heading.getAttribute('id')
    );
    expect(headings).toEqual(['session-defaults-heading', 'personal-preferences-heading']);

    const organizationSection = section('session-defaults-heading');
    expect(organizationSection.textContent).toContain('Default sandbox');
    expect(organizationSection.textContent).toContain('Repository overrides');
    expect(organizationSection.textContent).not.toContain('Collapse tool calls');
    expect(organizationSection.textContent).not.toContain('Background models');
    expect(organizationSection.closest('[data-tab]')?.getAttribute('data-tab')).toBe('general');

    const personalSection = section('personal-preferences-heading');
    const personalText = personalSection.textContent ?? '';
    expect(personalSection.closest('[data-tab]')?.getAttribute('data-tab')).toBe('preferences');
    expect(personalText).toContain('Collapse tool calls');
    expect(personalText).toContain('Modes');
    expect(personalText).toContain('Background models');
    expect(personalText).not.toContain('Default sandbox');
    expect(personalText).not.toContain('Repository overrides');
    expect(personalText.indexOf('Display')).toBeLessThan(personalText.indexOf('Modes'));
  });

  it('labels sidebar groups by who the settings apply to', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(true) }));
    renderDialog('org-1');

    const navText = Array.from(domDocument.querySelectorAll('[role="presentation"]')).map(label =>
      (label.textContent ?? '').trim()
    );
    expect(navText).toEqual(['Organization', 'You']);
  });

  it('keeps personal preferences editable when organization settings are view only', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(false) }));
    renderDialog('org-1');

    expect(domDocument.body.textContent).toContain(
      'Organization settings are view only. Your personal preferences remain editable.'
    );
    expect(section('personal-preferences-heading').textContent).toContain('Only you');

    const toggle = personalSwitch();
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    act(() => toggle.click());

    expect(personalSwitch().getAttribute('aria-checked')).toBe('true');
    expect(localStorageStub.getItem('cloud-agent:collapse-tools')).toBe('true');
  });

  it('scopes session defaults copy to the personal workspace', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(true) }));
    renderDialog();

    expect(badgeTexts()).toEqual([
      'Personal workspace',
      'New sessions',
      'Only you',
      'This browser',
    ]);

    const organizationSection = section('session-defaults-heading');
    expect(organizationSection.textContent).toContain('Session defaults');
    expect(organizationSection.textContent).not.toContain('All members');

    const navText = Array.from(domDocument.querySelectorAll('[role="presentation"]')).map(label =>
      (label.textContent ?? '').trim()
    );
    expect(navText).toEqual(['Workspace', 'You']);
  });

  it('keeps the personal preference control available while settings load', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: undefined }));
    renderDialog('org-1');

    expect(domDocument.querySelector('[role="status"]')?.textContent).toContain(
      'Loading settings...'
    );
    expect(section('personal-preferences-heading').textContent).toContain('Collapse tool calls');

    const toggle = personalSwitch();
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('keeps the personal preference control available when settings fail to load', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: undefined, isError: true }));
    renderDialog('org-1');

    expect(domDocument.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not load Cloud Agent settings.'
    );
    expect(section('personal-preferences-heading').textContent).toContain('Collapse tool calls');

    const toggle = personalSwitch();
    expect(toggle.disabled).toBe(false);
    act(() => toggle.click());

    expect(personalSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('reports section changes so callers can sync the URL', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(true) }));
    const onSectionChange = jest.fn();
    act(() => {
      root.render(
        createElement(CloudAgentSettingsDialog, {
          organizationId: undefined,
          open: true,
          onOpenChange: () => undefined,
          onSectionChange,
        })
      );
    });

    const environments = Array.from(domDocument.querySelectorAll('button')).find(
      button => button.textContent?.trim() === 'Environments'
    );
    if (!environments) throw new Error('Missing Environments tab');

    act(() => environments.click());

    expect(onSectionChange).toHaveBeenCalledWith('environments');

    const preferences = Array.from(domDocument.querySelectorAll('button')).find(
      button => button.textContent?.trim() === 'Preferences'
    );
    if (!preferences) throw new Error('Missing Preferences tab');

    act(() => preferences.click());

    expect(onSectionChange).toHaveBeenCalledWith('preferences');
  });
});
