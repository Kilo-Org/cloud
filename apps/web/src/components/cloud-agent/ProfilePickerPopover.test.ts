/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest node-environment mocks must be registered before loading the component. */
// A failed background refetch keeps `data` in React Query while setting `error`.
// The picker must keep showing the cached profiles (and the active profile) in
// that state, and only fall back to the retry error when there is nothing to
// show. The profiles hooks are stubbed with exactly that state; the popover
// primitives render their children so the content is present in static markup.
import { jest } from '@jest/globals';
import React, { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as ProfilePickerPopoverModule from './ProfilePickerPopover';

let mockCombined: unknown;
let mockPersonal: unknown;

jest.mock('@/hooks/useCloudAgentProfiles', () => ({
  useCombinedProfiles: () => mockCombined,
  useProfiles: () => mockPersonal,
  useRepoBindings: () => ({ data: [] }),
}));

jest.mock('@/components/ui/popover', () => {
  const react = jest.requireActual<typeof React>('react');
  const block = (tag: string) => {
    const Block = ({ children }: { children?: ReactNode }) =>
      react.createElement(tag, null, children);
    Block.displayName = `Mock${tag}`;
    return Block;
  };
  return { Popover: block('div'), PopoverTrigger: block('button'), PopoverContent: block('div') };
});

jest.mock('@/components/cloud-agent/ProfilesListDialog', () => ({
  ProfilesListDialog: () => null,
}));

const { ProfilePickerPopover } =
  require('./ProfilePickerPopover') as typeof ProfilePickerPopoverModule;

Object.assign(globalThis, { React });

const PROFILE = {
  id: 'profile-1',
  name: 'Production',
  ownerType: 'organization',
  varCount: 2,
  mcpServerCount: 1,
  skillCount: 0,
  kiloCommandCount: 0,
};

function renderPicker(): string {
  return renderToStaticMarkup(
    createElement(ProfilePickerPopover, {
      organizationId: 'org-1',
      selectedOverrideProfileId: null,
      onOverrideProfileSelect: jest.fn(),
    })
  );
}

describe('ProfilePickerPopover profiles error state', () => {
  it('keeps the picker when a refetch fails but cached profiles remain', () => {
    mockCombined = {
      data: { allProfiles: [PROFILE], effectiveDefaultId: null },
      isLoading: false,
      error: new Error('refetch failed'),
      refetch: jest.fn(),
    };
    mockPersonal = { data: [], isLoading: false, error: undefined, refetch: jest.fn() };

    const markup = renderPicker();
    expect(markup).toContain('Production');
    expect(markup).toContain('Pick a profile');
    expect(markup).not.toContain('Could not load profiles.');
  });

  it('shows the retry state when the list failed with nothing cached', () => {
    mockCombined = {
      data: undefined,
      isLoading: false,
      error: new Error('refetch failed'),
      refetch: jest.fn(),
    };
    mockPersonal = { data: [], isLoading: false, error: undefined, refetch: jest.fn() };

    const markup = renderPicker();
    expect(markup).toContain('Could not load profiles.');
    expect(markup).not.toContain('Pick a profile');
  });
});
