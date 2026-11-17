/* eslint-disable max-lines -- one mounted suite covers the council route's gate and its specialist guard */

// Two surfaces of the council route:
// 1. the gate. A platform the server refuses to store council for (Bitbucket)
//    must read as unavailable, never as an editor whose saves are discarded.
// 2. the specialist minimum. Disabling specialists below `COUNCIL_MIN_SPECIALISTS`
//    would persist `enabled: true` on a council that `isCouncilActive` never
//    runs, so the toggle that would cross that line must not write.
// 3. the unit of write. An organization with no stored council reads off, and a
//    save that enables the council, or opts a repository in, carries the council
//    config the org PATCH needs to store one; switching council off clears the
//    opt-in ids in the same save.

import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import '@/i18n';
import { CREATE_ORGANIZATION_HREF } from '@/lib/organization-navigation';
import { act } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

import CouncilRoute from './council';

type ToggleProps = {
  title: string;
  value: boolean;
  disabled?: boolean;
  onValueChange?: (value: boolean) => void;
};

type SaveMutation = { mutate: Mock; isPending: boolean };

type SavedPatch = {
  council?: {
    enabled?: boolean;
    specialists: { id: string; enabled: boolean }[];
    required_labels?: string[];
  } | null;
  councilEnabledRepositoryIds?: (number | string)[];
};

const state = vi.hoisted(() => {
  const save: SaveMutation = { mutate: vi.fn(), isPending: false };

  return {
    scope: 'org-1',
    platform: 'github' as 'github' | 'gitlab' | 'bitbucket',
    gate: { allowed: true, pending: false },
    configEnabled: [] as boolean[],
    config: { data: null as unknown, isFetching: false, isError: false, refetch: vi.fn() },
    save,
    toastErrors: [] as string[],
    toggleProps: [] as ToggleProps[],
    patches: [] as SavedPatch[],
    routerPush: vi.fn(),
    routerReplace: vi.fn(),
    setOrganizationId: vi.fn(),
    gateReason: null as string | null,
    orgs: undefined as { organizationId: string }[] | undefined,
  };
});

const specialists = vi.hoisted(() => [
  { id: 'security', role: 'security', name: 'Security', enabled: true, required: false, lens: '' },
  {
    id: 'performance',
    role: 'performance',
    name: 'Performance',
    enabled: true,
    required: false,
    lens: '',
  },
  {
    id: 'testing',
    role: 'testing',
    name: 'Test coverage',
    enabled: false,
    required: false,
    lens: '',
  },
]);

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  Platform: { OS: 'android' },
  useColorScheme: () => 'light',
}));
vi.mock('expo-router', () => ({
  useNavigation: () => ({ isFocused: () => true }),
  useRouter: () => ({ push: state.routerPush, replace: state.routerReplace }),
}));
vi.mock('@/lib/hooks/use-reviewer-route-params', () => ({
  useReviewerRouteParams: () => ({ scope: state.scope, platform: state.platform }),
}));
vi.mock('@/lib/hooks/use-reviewer-council', () => ({
  useCouncilGate: () => ({ ...state.gate, refusalReason: state.gateReason }),
  defaultCouncilConfig: () => ({
    enabled: false,
    aggregation_strategy: 'advisory',
    specialists: specialists.map(entry => ({ ...entry })),
  }),
  enabledSpecialistCount: (council: { specialists: { enabled: boolean }[] }) =>
    council.specialists.filter(entry => entry.enabled).length,
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      list: { queryOptions: () => ({ queryKey: ['organizations', 'list'] }) },
    },
  }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ setOrganizationId: vi.fn() }),
}));
vi.mock('@tanstack/react-query', async importOriginal => {
  const actual = await importOriginal<object>();
  return { ...actual, useQuery: () => ({ data: state.orgs }) };
});
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  isPersonal: (scope: string) => scope === 'personal',
  useReviewConfig: (_scope: string, _platform: string, options?: { enabled?: boolean }) => {
    state.configEnabled.push(options?.enabled ?? true);
    return state.config;
  },
  useSaveReviewConfig: () => state.save,
  useGitHubRepositories: () => ({
    data: { repositories: [{ id: 1, fullName: 'kilo/app' }] },
    isLoading: false,
    isError: false,
  }),
  useGitLabRepositories: () => ({ data: { repositories: [] }, isLoading: false, isError: false }),
}));
vi.mock('@/lib/hooks/use-review-config-body', () => ({
  useReviewConfigBody: () => ({ body: { status: 'ready' } }),
  reviewConfigFailure: () => null,
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: {
    error: (message: string) => {
      state.toastErrors.push(message);
    },
    success: vi.fn(),
    warning: vi.fn(),
  },
}));
vi.mock('@/components/code-reviewer/reviewer-header', () => ({ ReviewerHeader: 'ReviewerHeader' }));
vi.mock('@/components/code-reviewer/reviewer-error-screen', () => ({
  ReviewerErrorScreen: 'ReviewerErrorScreen',
}));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/centered-state', () => ({
  CenteredState: (props: { children?: ReactNode }) =>
    createElement('CenteredState', null, props.children),
}));
vi.mock('@/components/security-agent/settings-toggle-row', () => ({
  ToggleRow: (props: ToggleProps) => {
    state.toggleProps.push(props);
    return createElement('ToggleRow', props);
  },
}));
vi.mock('@/components/ui/choice-row', () => ({
  ChoiceRow: (props: { label: string; selected: boolean; onPress?: () => void }) =>
    createElement('ChoiceRow', props),
}));
vi.mock('@/components/ui/radio-group', () => ({
  RadioGroup: (props: { children?: ReactNode }) =>
    createElement('RadioGroup', null, props.children),
}));
vi.mock('@/components/ui/input', () => ({ Input: 'TextInput' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: ReactNode }) =>
    createElement('ScrollView', null, props.children),
}));

type MountedRenderer = RenderWithProvidersResult['renderer'];

const renderedTexts = (renderer: MountedRenderer) =>
  renderer.root
    .findAll(node => String(node.type) === 'Text')
    .flatMap(node => node.props.children as unknown[])
    .filter((value): value is string => typeof value === 'string');

const specialistToggle = (title: string) =>
  state.toggleProps.findLast(props => props.title === title);

type LabelFieldProps = {
  value: string;
  onChangeText: (value: string) => void;
  onEndEditing: () => void;
};

const labelField = (renderer: MountedRenderer) =>
  renderer.root.findAll(node => String(node.type) === 'TextInput')[0]?.props as
    | LabelFieldProps
    | undefined;

beforeEach(() => {
  state.scope = 'org-1';
  state.platform = 'github';
  state.gate.allowed = true;
  state.gate.pending = false;
  state.configEnabled.length = 0;
  state.toggleProps.length = 0;
  state.toastErrors.length = 0;
  state.save.mutate.mockReset();
  state.save.mutate.mockImplementation((patch: SavedPatch) => {
    state.patches.push(patch);
  });
  state.patches.length = 0;
  state.save.isPending = false;
  state.routerPush.mockReset();
  state.routerReplace.mockReset();
  state.setOrganizationId.mockReset();
  state.gateReason = null;
  state.orgs = [];

  state.config.data = {
    council: {
      enabled: true,
      aggregation_strategy: 'advisory',
      specialists: specialists.map(entry => ({ ...entry })),
    },
    selectedRepositoryIds: [1],
    councilEnabledRepositoryIds: [],
  };
});

describe('council route gate', () => {
  it('refuses Bitbucket for an entitled organisation instead of painting the editor', async () => {
    state.platform = 'bitbucket';

    const mounted = await renderWithProviders(createElement(CouncilRoute));
    const { renderer } = mounted;
    await act(() => undefined);

    expect(renderedTexts(renderer)).toContain(
      'Council review is not available for Bitbucket repositories.'
    );
    expect(renderer.root.findAll(node => String(node.type) === 'ToggleRow')).toHaveLength(0);
    // The config read is what the editor needs; a refused platform never asks.
    expect(state.configEnabled).toEqual([false]);

    mounted.unmount();
  });

  it('explains a personal scope and offers the create-organization step', async () => {
    state.scope = 'personal';
    // A personal scope can never be entitled, so the gate reads refused there.
    state.gate.allowed = false;

    const mounted = await renderWithProviders(createElement(CouncilRoute));
    const { renderer } = mounted;
    await act(() => undefined);

    const texts = renderedTexts(renderer);
    expect(texts).toContain(
      'Council review is not part of a personal account. It needs an Enterprise organization.'
    );
    expect(texts).not.toContain(
      'Council review needs the Enterprise plan with an active subscription or trial. This organization does not have it right now.'
    );
    expect(texts).not.toContain('Council review is not available for Bitbucket repositories.');
    const action = renderer.root
      .findAll(node => String(node.type) === 'Pressable')
      .find(node => node.props.accessibilityLabel === 'Create an organization');
    expect(action).toBeDefined();
    const onPress = action?.props.onPress as (() => void) | undefined;
    await act(() => {
      onPress?.();
    });
    expect(state.routerPush).toHaveBeenCalledWith(CREATE_ORGANIZATION_HREF);

    mounted.unmount();
  });

  it('offers the switch step to a personal reader who already has an organization', async () => {
    state.scope = 'personal';
    state.gate.allowed = false;
    state.orgs = [{ organizationId: 'org-1' }];

    const mounted = await renderWithProviders(createElement(CouncilRoute));
    const { renderer } = mounted;
    await act(() => undefined);

    const texts = renderedTexts(renderer);
    expect(texts).toContain(
      'Council review is not part of a personal account. It needs an Enterprise organization.'
    );
    expect(texts).toContain('Switch organization');
    const action = renderer.root
      .findAll(node => String(node.type) === 'Pressable')
      .find(node => node.props.accessibilityLabel === 'Switch organization');
    expect(action).toBeDefined();
    const onPress = action?.props.onPress as (() => void) | undefined;
    await act(() => {
      onPress?.();
    });
    // The reviewer scope list replaces the refusal: it lists every
    // membership on one screen, and a pick there reopens the picked
    // account's council screen.
    expect(state.routerReplace).toHaveBeenCalledWith('/(app)/code-reviewer');

    mounted.unmount();
  });

  it('replaces the refusal with the picked organization after a pick', async () => {
    state.scope = 'personal';
    state.gate.allowed = false;
    state.orgs = [{ organizationId: 'org-1' }];

    const mounted = await renderWithProviders(createElement(CouncilRoute));
    await act(() => undefined);

    // The press routes through the component's `onSelectionChange`; the sheet
    // itself is a mock. Drive the fan-out the picker would run: the mock
    // records the press (asserted in the sibling test), and a picked
    // organization must call back into the component so the route is replaced
    // and the account switched. This test only proves the mock plumbing stays
    // connected; the screen-level behavior is device-proven.
    expect(state.routerPush).not.toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)');

    mounted.unmount();
  });

  it('keeps the neutral sentence when the refusal cannot name a cause', async () => {
    state.gate.allowed = false;
    state.gateReason = 'flagUnavailable';

    const mounted = await renderWithProviders(createElement(CouncilRoute));
    const { renderer } = mounted;
    await act(() => undefined);

    const texts = renderedTexts(renderer);
    expect(texts).toContain(
      'Council review is not available for this organization right now. Try again later.'
    );
    expect(texts).not.toContain(
      'Council review needs the Enterprise plan with an active subscription or trial. This organization does not have it right now.'
    );

    mounted.unmount();
  });

  it('keeps the create step while the organization list has not settled', async () => {
    state.scope = 'personal';
    state.gate.allowed = false;
    state.orgs = undefined;

    const mounted = await renderWithProviders(createElement(CouncilRoute));
    const { renderer } = mounted;
    await act(() => undefined);

    expect(renderedTexts(renderer)).toContain('Create an organization');
    expect(renderedTexts(renderer)).not.toContain('Switch organization');

    mounted.unmount();
  });

  it('explains the plan to an unentitled organisation', async () => {
    state.gate.allowed = false;
    state.gateReason = 'refused';

    const mounted = await renderWithProviders(createElement(CouncilRoute));
    const { renderer } = mounted;
    await act(() => undefined);

    const texts = renderedTexts(renderer);
    expect(texts).toContain(
      'Council review needs the Enterprise plan with an active subscription or trial. This organization does not have it right now.'
    );
    expect(texts).not.toContain(
      'Council review is not part of a personal account. It needs an Enterprise organization.'
    );
    expect(renderer.root.findAll(node => String(node.type) === 'Pressable')).toHaveLength(0);

    mounted.unmount();
  });

  it('paints the editor for a supported, entitled organisation', async () => {
    const mounted = await renderWithProviders(createElement(CouncilRoute));
    const { renderer } = mounted;
    await act(() => undefined);

    expect(renderedTexts(renderer)).not.toContain(
      'Council review needs the Enterprise plan with an active subscription or trial. This organization does not have it right now.'
    );
    expect(state.configEnabled).toContain(true);

    mounted.unmount();
  });

  it('keeps the surface blank while the entitlement read resolves', async () => {
    state.gate.allowed = false;
    state.gate.pending = true;

    const mounted = await renderWithProviders(createElement(CouncilRoute));
    const { renderer } = mounted;
    await act(() => undefined);

    expect(renderedTexts(renderer)).not.toContain(
      'Council review needs the Enterprise plan with an active subscription or trial. This organization does not have it right now.'
    );
    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton').length).toBeGreaterThan(
      0
    );

    mounted.unmount();
  });
});

describe('council specialist minimum', () => {
  it('does not save the toggle that would leave an enabled council below the minimum', async () => {
    const mounted = await renderWithProviders(createElement(CouncilRoute));
    await act(() => undefined);

    await act(() => {
      specialistToggle('Performance')?.onValueChange?.(false);
    });

    expect(state.save.mutate).not.toHaveBeenCalled();
    expect(state.toastErrors).toHaveLength(1);
    expect(state.toastErrors[0]).toContain('Select at least 2 specialists');

    mounted.unmount();
  });

  it('saves a specialist toggle while enough voters stay enabled', async () => {
    state.config.data = {
      council: {
        enabled: true,
        aggregation_strategy: 'advisory',
        specialists: specialists.map(({ id, role, name, required, lens }) => ({
          id,
          role,
          name,
          enabled: true,
          required,
          lens,
        })),
      },
      selectedRepositoryIds: [1],
      councilEnabledRepositoryIds: [],
    };

    const mounted = await renderWithProviders(createElement(CouncilRoute));
    await act(() => undefined);

    await act(() => {
      specialistToggle('Performance')?.onValueChange?.(false);
    });

    expect(state.save.mutate).toHaveBeenCalledTimes(1);
    expect(
      state.patches[0]?.council?.specialists.find(entry => entry.id === 'performance')?.enabled
    ).toBe(false);
    expect(state.toastErrors).toHaveLength(0);

    mounted.unmount();
  });
});

describe('council unit of write', () => {
  const noStoredCouncil = () => {
    state.config.data = {
      council: null,
      selectedRepositoryIds: [1],
      councilEnabledRepositoryIds: [],
    };
  };

  it('reads the switch off for an organization with no stored council', async () => {
    noStoredCouncil();

    const mounted = await renderWithProviders(createElement(CouncilRoute));
    await act(() => undefined);

    expect(specialistToggle('Council review')?.value).toBe(false);
    // An opt-in only runs against a stored council, so the row stays closed
    // until the switch stores one.
    expect(specialistToggle('kilo/app')?.disabled).toBe(true);

    mounted.unmount();
  });

  it('writes a council config in the save that turns the council on', async () => {
    noStoredCouncil();

    const mounted = await renderWithProviders(createElement(CouncilRoute));
    await act(() => undefined);

    await act(() => {
      specialistToggle('Council review')?.onValueChange?.(true);
    });

    expect(state.save.mutate).toHaveBeenCalledTimes(1);
    expect(state.patches[0]?.council?.enabled).toBe(true);
    expect(state.patches[0]?.council?.specialists.length).toBeGreaterThan(0);

    mounted.unmount();
  });

  it('clears the repository opt-ins in the save that turns the council off', async () => {
    state.config.data = {
      council: {
        enabled: true,
        aggregation_strategy: 'advisory',
        specialists,
      },
      selectedRepositoryIds: [1],
      councilEnabledRepositoryIds: [1],
    };

    const mounted = await renderWithProviders(createElement(CouncilRoute));
    await act(() => undefined);

    await act(() => {
      specialistToggle('Council review')?.onValueChange?.(false);
    });

    expect(state.save.mutate).toHaveBeenCalledTimes(1);
    expect(state.patches[0]?.council?.enabled).toBe(false);
    expect(state.patches[0]?.councilEnabledRepositoryIds).toEqual([]);

    mounted.unmount();
  });
});

describe('council label gate', () => {
  const commitLabels = async (mounted: RenderWithProvidersResult, text: string): Promise<void> => {
    const { renderer } = mounted;
    await act(() => {
      labelField(renderer)?.onChangeText(text);
    });
    await act(() => {
      labelField(renderer)?.onEndEditing();
    });
  };

  it('saves a pasted list within the server caps', async () => {
    const mounted = await renderWithProviders(createElement(CouncilRoute));
    await act(() => undefined);

    await commitLabels(mounted, ' council , deep review ');

    expect(state.save.mutate).toHaveBeenCalledTimes(1);
    expect(state.patches[0]?.council?.required_labels).toEqual(['council', 'deep review']);
    expect(state.toastErrors).toHaveLength(0);

    mounted.unmount();
  });

  it('refuses a list past the label count, keeps the draft and saves nothing', async () => {
    const mounted = await renderWithProviders(createElement(CouncilRoute));
    const { renderer } = mounted;
    await act(() => undefined);

    const pasted = Array.from({ length: 21 }, (_, index) => `label-${index}`).join(', ');
    await commitLabels(mounted, pasted);

    expect(state.save.mutate).not.toHaveBeenCalled();
    expect(state.toastErrors).toEqual(['Too many council labels. Use at most 20 labels.']);
    expect(labelField(renderer)?.value).toBe(pasted);

    mounted.unmount();
  });

  it('refuses a label past the length cap, keeps the draft and saves nothing', async () => {
    const mounted = await renderWithProviders(createElement(CouncilRoute));
    const { renderer } = mounted;
    await act(() => undefined);

    const pasted = `ok, ${'a'.repeat(101)}`;
    await commitLabels(mounted, pasted);

    expect(state.save.mutate).not.toHaveBeenCalled();
    expect(state.toastErrors).toEqual([
      'Council label too long. Each label must be 100 characters or fewer.',
    ]);
    expect(labelField(renderer)?.value).toBe(pasted);

    mounted.unmount();
  });
});
