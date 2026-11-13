import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CloudAgentSettingsData } from '@/hooks/useCloudAgentSettings';
import type { CloudAgentSettingsDialog as CloudAgentSettingsDialogComponent } from './CloudAgentSettingsDialog';

const mockUseCloudAgentSettings = jest.fn();
const mockUseVercelComputeEnrollment = jest.fn();
const mockUseVercelComputeStatus = jest.fn();

jest.mock('@/hooks/useVercelComputeStatus', () => ({
  useVercelComputeStatus: (options: unknown) => mockUseVercelComputeStatus(options),
}));

jest.mock('@/hooks/useVercelComputeEnrollment', () => ({
  useVercelComputeEnrollment: (options: unknown) => mockUseVercelComputeEnrollment(options),
}));

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

jest.mock('./VercelComputeSettings', () => ({
  VercelComputeSettings: () => createElement('div', { 'data-section': 'vercel-compute' }),
}));

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
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
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

function selectTab(label: string): void {
  const tab = Array.from(domDocument.querySelectorAll('[role="tab"]')).find(
    element => element.textContent?.trim() === label
  );
  if (!tab) throw new Error(`Missing ${label} tab`);
  act(() => {
    tab.dispatchEvent(
      Object.assign(new domWindow.Event('keydown', { bubbles: true }), { key: 'Enter' })
    );
  });
}

describe('CloudAgentSettingsDialog scope grouping', () => {
  let root: Root;

  beforeEach(() => {
    storage.clear();
    mockUseCloudAgentSettings.mockReset();
    mockUseVercelComputeEnrollment.mockReset();
    mockUseVercelComputeEnrollment.mockReturnValue({
      isSuccess: true,
      data: { enrolled: false },
    });
    mockUseVercelComputeStatus.mockReset();
    mockUseVercelComputeStatus.mockReturnValue({ isSuccess: true, data: null });
    const container = domDocument.getElementById('root');
    if (!container) throw new Error('Missing settings dialog test root');
    act(() => {
      root = createRoot(container);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  function renderDialog(organizationId?: string, initialSection?: 'compute'): void {
    act(() => {
      root.render(
        createElement(CloudAgentSettingsDialog, {
          organizationId,
          open: true,
          onOpenChange: () => undefined,
          initialSection,
        })
      );
    });
  }

  it.each([undefined, 'org-1'])(
    'shows compute for an enrolled manager in %s scope',
    organizationId => {
      mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(true) }));
      mockUseVercelComputeEnrollment.mockReturnValue({
        isSuccess: true,
        data: { enrolled: true },
      });
      renderDialog(organizationId, 'compute');

      expect(domDocument.querySelector('[data-section="vercel-compute"]')).not.toBeNull();
      expect(domDocument.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe(
        'Compute'
      );
      expect(mockUseVercelComputeEnrollment).toHaveBeenCalledWith({
        organizationId,
        enabled: true,
      });
    }
  );

  it.each([
    ['not enrolled', { isSuccess: true, data: { enrolled: false } }],
    ['loading', { isSuccess: false, data: undefined }],
  ])('hides compute when enrollment is %s, including deep links', (_label, enrollment) => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(true) }));
    mockUseVercelComputeEnrollment.mockReturnValue(enrollment);
    renderDialog('org-1', 'compute');

    expect(
      Array.from(domDocument.querySelectorAll('[role="tab"]')).some(
        tab => tab.textContent?.trim() === 'Compute'
      )
    ).toBe(false);
    expect(domDocument.querySelector('[data-section="vercel-compute"]')).toBeNull();
    expect(section('session-defaults-heading').textContent).toContain('Default sandbox');
  });

  it.each([undefined, 'org-1'])(
    'keeps compute reachable for an unenrolled owner with credentials in %s scope',
    organizationId => {
      mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(true) }));
      mockUseVercelComputeStatus.mockReturnValue({
        isSuccess: true,
        data: { id: 'credential-1' },
      });
      renderDialog(organizationId, 'compute');

      expect(domDocument.querySelector('[data-section="vercel-compute"]')).not.toBeNull();
      expect(mockUseVercelComputeStatus).toHaveBeenCalledWith({
        organizationId,
        enabled: true,
      });
    }
  );

  it.each([
    ['enrollment', { isError: true, isSuccess: false, data: undefined }, { data: null }],
    [
      'cached enrollment',
      { isError: true, isSuccess: false, data: { enrolled: true } },
      { data: null },
    ],
    ['status', { isSuccess: true, data: { enrolled: false } }, { isError: true }],
  ])('keeps compute reachable to retry a failed %s check', (_label, enrollment, status) => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(true) }));
    mockUseVercelComputeEnrollment.mockReturnValue(enrollment);
    mockUseVercelComputeStatus.mockReturnValue(status);
    renderDialog('org-1', 'compute');

    expect(domDocument.querySelector('[data-section="vercel-compute"]')).not.toBeNull();
    expect(domDocument.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe(
      'Compute'
    );
  });

  it.each([undefined, 'org-1'])(
    'does not check compute access or show compute without management permission in %s scope',
    organizationId => {
      mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(false) }));
      mockUseVercelComputeEnrollment.mockReturnValue({
        isSuccess: true,
        data: { enrolled: true },
      });
      mockUseVercelComputeStatus.mockReturnValue({ data: { id: 'credential-1' }, isError: true });
      renderDialog(organizationId, 'compute');

      expect(domDocument.querySelector('[data-section="vercel-compute"]')).toBeNull();
      expect(mockUseVercelComputeEnrollment).toHaveBeenCalledWith({
        organizationId,
        enabled: false,
      });
      expect(mockUseVercelComputeStatus).toHaveBeenCalledWith({
        organizationId,
        enabled: false,
      });
      expect(section('session-defaults-heading').textContent).toContain('Default sandbox');
    }
  );

  it('hides compute after an unenrolled owner removes the credentials', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(true) }));
    mockUseVercelComputeStatus.mockReturnValue({ data: { id: 'credential-1' } });
    renderDialog('org-1', 'compute');
    expect(domDocument.querySelector('[data-section="vercel-compute"]')).not.toBeNull();

    mockUseVercelComputeStatus.mockReturnValue({ isSuccess: true, data: null });
    renderDialog('org-1', 'compute');

    expect(domDocument.querySelector('[data-section="vercel-compute"]')).toBeNull();
    expect(section('session-defaults-heading').textContent).toContain('Default sandbox');
  });

  it('returns to general if compute access is removed while the tab is open', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(true) }));
    mockUseVercelComputeEnrollment.mockReturnValue({
      isSuccess: true,
      data: { enrolled: true },
    });
    renderDialog('org-1', 'compute');
    expect(domDocument.querySelector('[data-section="vercel-compute"]')).not.toBeNull();

    mockUseVercelComputeEnrollment.mockReturnValue({
      isSuccess: true,
      data: { enrolled: false },
    });
    renderDialog('org-1', 'compute');

    expect(domDocument.querySelector('[data-section="vercel-compute"]')).toBeNull();
    expect(section('session-defaults-heading').textContent).toContain('Default sandbox');
  });

  it('opens a compute deep link after enrollment is confirmed', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(true) }));
    mockUseVercelComputeEnrollment.mockReturnValue({ isSuccess: false, data: undefined });
    renderDialog('org-1', 'compute');

    expect(domDocument.querySelector('[data-section="vercel-compute"]')).toBeNull();
    expect(section('session-defaults-heading').textContent).toContain('Default sandbox');

    mockUseVercelComputeEnrollment.mockReturnValue({
      isSuccess: true,
      data: { enrolled: true },
    });
    renderDialog('org-1', 'compute');

    expect(domDocument.querySelector('[data-section="vercel-compute"]')).not.toBeNull();
    expect(domDocument.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe(
      'Compute'
    );
  });

  it('separates organization settings from personal preferences', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(true) }));
    renderDialog('org-1');

    expect(badgeTexts()).toEqual(['Organization workspace', 'All members']);

    const headings = Array.from(domDocument.querySelectorAll('h3')).map(heading =>
      heading.getAttribute('id')
    );
    expect(headings).toEqual(['session-defaults-heading']);

    const organizationSection = section('session-defaults-heading');
    expect(organizationSection.textContent).toContain('Default sandbox');
    expect(organizationSection.textContent).toContain('Repository overrides');
    expect(organizationSection.textContent).not.toContain('Collapse tool calls');
    expect(organizationSection.textContent).not.toContain('Background models');
    expect(organizationSection.closest('[role="tabpanel"]')?.getAttribute('data-state')).toBe(
      'active'
    );

    selectTab('Preferences');

    expect(badgeTexts()).toEqual(['Organization workspace', 'Only you', 'This browser']);
    expect(domDocument.querySelector('#session-defaults-heading')).toBeNull();

    const personalSection = section('personal-preferences-heading');
    const personalText = personalSection.textContent ?? '';
    expect(personalSection.closest('[role="tabpanel"]')?.getAttribute('data-state')).toBe('active');
    expect(personalText).toContain('Collapse tool calls');
    expect(personalText).toContain('Modes');
    expect(personalText).toContain('Background models');
    expect(personalText).not.toContain('Default sandbox');
    expect(personalText).not.toContain('Repository overrides');
    expect(personalText.indexOf('Display')).toBeLessThan(personalText.indexOf('Modes'));

    selectTab('General');
    expect(domDocument.querySelector('#personal-preferences-heading')).toBeNull();
    expect(domDocument.querySelector('[role="switch"]')).toBeNull();
    expect(badgeTexts()).toEqual(['Organization workspace', 'All members']);
  });

  it('labels sidebar groups by who the settings apply to', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(true) }));
    renderDialog('org-1');

    const navText = Array.from(
      domDocument.querySelectorAll('[role="tablist"] > div[aria-hidden="true"]')
    )
      .map(label => (label.textContent ?? '').trim())
      .filter(Boolean);
    expect(navText).toEqual(['Organization', 'You']);
    for (const decoration of domDocument.querySelectorAll(
      '[role="tablist"] > :not([role="tab"])'
    )) {
      expect(decoration.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('keeps personal preferences editable when organization settings are view only', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(false) }));
    renderDialog('org-1');

    expect(domDocument.body.textContent).toContain(
      'Organization settings are view only. Your personal preferences remain editable.'
    );
    selectTab('Preferences');
    expect(section('personal-preferences-heading').textContent).toContain('Only you');

    const toggle = personalSwitch();
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    const descriptionId = toggle.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    expect(domDocument.getElementById(descriptionId ?? '')?.textContent).toBe(
      'Groups tool calls and reasoning between messages into one row you can expand.'
    );

    act(() => toggle.click());

    expect(personalSwitch().getAttribute('aria-checked')).toBe('true');
    expect(localStorageStub.getItem('cloud-agent:collapse-tools')).toBe('true');
  });

  it('scopes session defaults copy to the personal workspace', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: settings(true) }));
    renderDialog();

    expect(badgeTexts()).toEqual(['Personal workspace', 'New sessions']);

    const organizationSection = section('session-defaults-heading');
    expect(organizationSection.textContent).toContain('Session defaults');
    expect(organizationSection.textContent).not.toContain('All members');

    const navText = Array.from(
      domDocument.querySelectorAll('[role="tablist"] > div[aria-hidden="true"]')
    )
      .map(label => (label.textContent ?? '').trim())
      .filter(Boolean);
    expect(navText).toEqual(['Workspace', 'You']);

    selectTab('Preferences');
    expect(badgeTexts()).toEqual(['Personal workspace', 'Only you', 'This browser']);
  });

  it('keeps the personal preference control available while settings load', () => {
    mockUseCloudAgentSettings.mockReturnValue(queryResult({ data: undefined }));
    renderDialog('org-1');

    expect(domDocument.querySelector('[role="status"]')?.textContent).toContain(
      'Loading settings...'
    );
    selectTab('Preferences');
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
    selectTab('Preferences');
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

    selectTab('Environments');

    expect(onSectionChange).toHaveBeenCalledWith('environments');

    selectTab('Preferences');

    expect(onSectionChange).toHaveBeenCalledWith('preferences');
  });
});
