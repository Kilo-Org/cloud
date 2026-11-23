import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProfileSummaryWithOwner } from '@/hooks/useCloudAgentProfiles';
import type { ProfilePickerPopover as ProfilePickerPopoverComponent } from './ProfilePickerPopover';
import type { ProfilesListDialog } from './ProfilesListDialog';

const mockSetSection = jest.fn();
const mockClearSection = jest.fn();
const mockProfilesListDialogProps: React.ComponentProps<typeof ProfilesListDialog>[] = [];
const mockTopProfile = jest.fn<() => ProfileSummaryWithOwner | null>();

jest.mock('@/components/cloud-agent-next/settings/useCloudAgentSettingsDeepLink', () => ({
  useCloudAgentSettingsDeepLink: () => ({
    open: false,
    initialSection: 'general',
    setSection: mockSetSection,
    clearSection: mockClearSection,
  }),
}));

jest.mock('@/hooks/useSessionProfileLayers', () => ({
  useSessionProfileLayers: () => ({
    allProfiles: [],
    profilesData: undefined,
    profilesLoading: false,
    profilesError: undefined,
    refetchProfiles: jest.fn(),
    layers: {},
    baseProfile: null,
    topProfile: mockTopProfile(),
  }),
}));

jest.mock('@/components/cloud-agent/ProfilesListDialog', () => ({
  ProfilesListDialog: (props: React.ComponentProps<typeof ProfilesListDialog>) => {
    mockProfilesListDialogProps.push(props);
    return null;
  },
}));

jest.mock('@/components/ui/popover', () => {
  const block =
    (tag: string) =>
    ({ children }: { children?: React.ReactNode }) =>
      createElement(tag, null, children);
  return { Popover: block('div'), PopoverTrigger: block('div'), PopoverContent: block('div') };
});

type LinkedomParseHtml = (html: string) => { window: typeof globalThis; document: Document };

const requireFromHere = createRequire(__filename);
const { parseHTML } = requireFromHere('linkedom') as { parseHTML: LinkedomParseHtml };
const { window: domWindow, document: domDocument } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);

Object.assign(globalThis, {
  React,
  window: domWindow,
  document: domDocument,
  HTMLElement: domWindow.HTMLElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { ProfilePickerPopover } = require('./ProfilePickerPopover') as {
  ProfilePickerPopover: typeof ProfilePickerPopoverComponent;
};

describe('ProfilePickerPopover settings deep link', () => {
  let root: Root;

  function renderPicker(organizationId?: string) {
    act(() => {
      root.render(
        createElement(ProfilePickerPopover, {
          organizationId,
          selectedOverrideProfileId: null,
          onOverrideProfileSelect: jest.fn(),
        })
      );
    });
  }

  beforeEach(() => {
    mockSetSection.mockReset();
    mockClearSection.mockReset();
    mockTopProfile.mockReset().mockReturnValue(null);
    mockProfilesListDialogProps.length = 0;
    const container = domDocument.getElementById('root');
    if (!container) throw new Error('Missing profile picker test root');
    act(() => {
      root = createRoot(container);
    });
    renderPicker();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it('writes the profiles section when Manage profiles is opened', () => {
    const manage = Array.from(domDocument.querySelectorAll('button')).find(button =>
      button.textContent?.includes('Manage profiles...')
    );
    if (!manage) throw new Error('Missing Manage profiles button');

    act(() => manage.click());

    expect(mockSetSection).toHaveBeenCalledWith('profiles');
  });

  it('opens Personal profiles to edit a personal profile in an organization workspace', () => {
    mockTopProfile.mockReturnValue({
      id: 'personal-profile',
      name: 'My Profile',
      ownerType: 'user',
      description: null,
      isDefault: true,
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
      varCount: 0,
      commandCount: 0,
      mcpServerCount: 0,
      skillCount: 0,
      agentCount: 0,
      kiloCommandCount: 0,
      instructionCount: 0,
    });
    renderPicker('org-1');
    const edit = domDocument.querySelector<HTMLButtonElement>('button[title="Edit profile"]');
    if (!edit) throw new Error('Missing Edit profile button');

    act(() => edit.click());

    expect(mockSetSection).toHaveBeenCalledWith('personal-profiles');
    expect(mockProfilesListDialogProps.at(-1)).toMatchObject({
      open: true,
      initialSection: 'personal-profiles',
      initialSelectedProfileId: 'personal-profile',
    });
  });

  it('clears the settings query when the profile dialog closes', () => {
    const dialog = mockProfilesListDialogProps[0];
    if (!dialog) throw new Error('Missing ProfilesListDialog');

    act(() => dialog.onOpenChange(false));

    expect(mockClearSection).toHaveBeenCalled();
  });
});
