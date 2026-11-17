import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProfilePickerPopover as ProfilePickerPopoverComponent } from './ProfilePickerPopover';

const mockSetSection = jest.fn();
const mockClearSection = jest.fn();
const mockProfilesListDialogProps: Array<{ onOpenChange?: (open: boolean) => void }> = [];

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
    topProfile: null,
  }),
}));

jest.mock('@/components/cloud-agent/ProfilesListDialog', () => ({
  ProfilesListDialog: (props: { onOpenChange?: (open: boolean) => void }) => {
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

  beforeEach(() => {
    mockSetSection.mockReset();
    mockClearSection.mockReset();
    mockProfilesListDialogProps.length = 0;
    const container = domDocument.getElementById('root');
    if (!container) throw new Error('Missing profile picker test root');
    act(() => {
      root = createRoot(container);
    });
    act(() => {
      root.render(
        createElement(ProfilePickerPopover, {
          selectedOverrideProfileId: null,
          onOverrideProfileSelect: jest.fn(),
        })
      );
    });
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

  it('clears the settings query when the profile dialog closes', () => {
    const dialog = mockProfilesListDialogProps[0];
    if (!dialog) throw new Error('Missing ProfilesListDialog');

    act(() => dialog.onOpenChange?.(false));

    expect(mockClearSection).toHaveBeenCalled();
  });
});
