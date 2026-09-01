/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the real native component without a DOM. */
import { type ComponentProps, type ReactElement, useState } from 'react';
import { Modal, Pressable, ScrollView } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { type AgentSessionFilters } from '@/lib/agent-session-filters';
import { SessionFilterChips, SessionFilterModal } from './platform-filter-modal';
import { PLATFORM_FILTERS } from './session-list-helpers';

vi.mock('react-native', () => ({
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', X: 'X' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ accentSoftForeground: '#1a1a10', primaryForeground: '#1a1a10' }),
}));

const projects = [
  { gitUrl: 'https://github.com/iscekic/kilo-workflow.git', displayName: 'ISCEKIC/KILO-WORKFLOW' },
  { gitUrl: 'https://github.com/Kilo-Org/kilocode.git', displayName: 'KILO-ORG/KILOCODE' },
  {
    gitUrl: 'https://github.com/example/a-repository-with-a-very-long-name.git',
    displayName: 'EXAMPLE/A-REPOSITORY-WITH-A-VERY-LONG-NAME-THAT-MUST-NOT-HIDE-THE-REMOVE-CONTROL',
  },
];
const unavailable = 'https://github.com/unavailable/a-saved-repository-with-a-very-long-name.git';
const longPlatform = 'a-future-platform-with-a-very-long-display-name';
const allProjects = projects.map(project => project.gitUrl);
const allPlatforms = [...PLATFORM_FILTERS, longPlatform];

type FixtureProps = Pick<
  ComponentProps<typeof SessionFilterChips>,
  'onRemoveProject' | 'onRemovePlatform'
> & {
  initialFilters: AgentSessionFilters;
  openPicker?: boolean;
};

function FilterFixture({
  initialFilters,
  openPicker = false,
  onRemoveProject,
  onRemovePlatform,
}: Readonly<FixtureProps>) {
  const [filters, setFilters] = useState(initialFilters);
  const [picking, setPicking] = useState(openPicker);
  return (
    <>
      <SessionFilterChips
        {...filters}
        projectOptions={projects}
        onRemoveProject={value => {
          onRemoveProject(value);
          setFilters(prev => ({
            ...prev,
            projectFilter: prev.projectFilter.filter(p => p !== value),
          }));
        }}
        onRemovePlatform={value => {
          onRemovePlatform(value);
          setFilters(prev => ({
            ...prev,
            platformFilter: prev.platformFilter.filter(p => p !== value),
          }));
        }}
      />
      {picking && (
        <SessionFilterModal
          selectedPlatforms={filters.platformFilter}
          selectedProjects={filters.projectFilter}
          projectOptions={projects}
          onApply={setFilters}
          onClose={() => {
            setPicking(false);
          }}
        />
      )}
    </>
  );
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

async function render(element: ReactElement) {
  const ref: { current?: TestRenderer.ReactTestRenderer } = {};
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(element);
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  mounted.push(ref.current);
  return ref.current;
}

function pillLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Pressable)
    .map(pill => pill.props.accessibilityLabel as string);
}

describe('SessionFilterChips', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => {
      for (const renderer of mounted) {
        renderer.unmount();
      }
    });
    mounted.length = 0;
  });

  it('renders no strip or spacer without selections', async () => {
    const renderer = await render(
      <SessionFilterChips
        projectFilter={[]}
        platformFilter={[]}
        projectOptions={projects}
        onRemoveProject={vi.fn<(value: string) => void>()}
        onRemovePlatform={vi.fn<(value: string) => void>()}
      />
    );
    expect(renderer.toJSON()).toBeNull();
  });

  it.each([
    { name: 'one repository', projectFilter: allProjects.slice(0, 1), platformFilter: [] },
    { name: 'two repositories', projectFilter: allProjects.slice(0, 2), platformFilter: [] },
    { name: 'overflowing long labels', projectFilter: allProjects, platformFilter: allPlatforms },
    { name: 'unavailable repository', projectFilter: [unavailable], platformFilter: ['cli'] },
    { name: 'platform-only long labels', projectFilter: [], platformFilter: allPlatforms },
  ])('constrains every pill for $name', async ({ projectFilter, platformFilter }) => {
    const renderer = await render(
      <SessionFilterChips
        projectFilter={projectFilter}
        platformFilter={platformFilter}
        projectOptions={projects}
        onRemoveProject={vi.fn<(value: string) => void>()}
        onRemovePlatform={vi.fn<(value: string) => void>()}
      />
    );
    const strip = renderer.root.findByType(ScrollView);
    const stripProps = strip.props as ComponentProps<typeof ScrollView>;
    expect(stripProps.horizontal).toBe(true);
    expect(stripProps.className?.split(' ')).toEqual(
      expect.arrayContaining(['grow-0', 'shrink-0'])
    );
    expect(stripProps.contentContainerClassName?.split(' ')).toEqual(
      expect.arrayContaining(['items-center', 'gap-2', 'px-[22px]', 'py-2'])
    );
    expect(stripProps.contentContainerStyle).toBeUndefined();
    const pills = strip.findAllByType(Pressable);
    expect(pills).toHaveLength(projectFilter.length + platformFilter.length);
    for (const pill of pills) {
      const pillProps = pill.props as ComponentProps<typeof Pressable>;
      expect(pillProps.accessibilityRole).toBe('button');
      expect(pillProps.className?.split(' ')).toEqual(
        expect.arrayContaining([
          'min-h-[48px]',
          'min-w-[48px]',
          'self-center',
          'shrink-0',
          'items-center',
          'rounded-full',
          'active:opacity-70',
        ])
      );
      const label = pill.findByType(Text);
      const labelProps = label.props as ComponentProps<typeof Text>;
      expect(labelProps.numberOfLines).toBe(1);
      expect(labelProps.className?.split(' ')).toContain('max-w-[220px]');
      expect(labelProps.allowFontScaling).not.toBe(false);
      expect(pillProps.accessibilityLabel).toContain(labelProps.children);
    }
  });

  it.each(['repository', 'platform'] as const)(
    'removes exact values, starting with a %s, without clearing the other dimension',
    async firstDimension => {
      const onRemoveProject = vi.fn<(value: string) => void>();
      const onRemovePlatform = vi.fn<(value: string) => void>();
      const renderer = await render(
        <FilterFixture
          initialFilters={{
            projectFilter: [...allProjects, unavailable],
            platformFilter: allPlatforms,
          }}
          onRemoveProject={onRemoveProject}
          onRemovePlatform={onRemovePlatform}
        />
      );
      const projectRemovals = [...projects, { gitUrl: unavailable, displayName: unavailable }].map(
        project => ({
          value: project.gitUrl,
          label: i18n.t('agentChat.sessionFilter.removeProjectFilter', {
            label: project.displayName,
          }),
          callback: onRemoveProject,
          otherCallback: onRemovePlatform,
        })
      );
      const pills = renderer.root.findAllByType(Pressable);
      expect(
        pills.slice(0, projectRemovals.length).map(pill => pill.findByType(Text).props.children)
      ).toEqual([...projects.map(project => project.displayName), unavailable]);
      const platformPills = pills.slice(projectRemovals.length);
      const platformRemovals = allPlatforms.map((platform, index) => ({
        value: platform,
        label: platformPills[index]?.props.accessibilityLabel as string,
        callback: onRemovePlatform,
        otherCallback: onRemoveProject,
      }));
      expect(pillLabels(renderer)).toContain(
        i18n.t('agentChat.sessionFilter.removeProjectFilter', { label: unavailable })
      );
      expect(platformPills.at(-1)?.findByType(Text).props.children).toBe(
        'A-FUTURE-PLATFORM-WITH-A-VERY-LONG-DISPLAY-NAME'
      );
      const removals =
        firstDimension === 'repository'
          ? [...projectRemovals, ...platformRemovals]
          : [...platformRemovals, ...projectRemovals];
      for (const removal of removals) {
        const before = pillLabels(renderer);
        const otherCalls = removal.otherCallback.mock.calls.length;
        act(() => {
          const pill = renderer.root.findByProps({ accessibilityLabel: removal.label });
          (pill.props.onPress as () => void)();
        });
        expect(removal.callback).toHaveBeenLastCalledWith(removal.value);
        expect(removal.otherCallback).toHaveBeenCalledTimes(otherCalls);
        expect(pillLabels(renderer)).toEqual(before.filter(label => label !== removal.label));
      }
      expect(onRemoveProject).toHaveBeenCalledTimes(projectRemovals.length);
      expect(onRemovePlatform).toHaveBeenCalledTimes(platformRemovals.length);
      expect(renderer.toJSON()).toBeNull();
    }
  );

  it('keeps draft selections out of the strip until Apply commits both arrays', async () => {
    const renderer = await render(
      <FilterFixture
        initialFilters={{ projectFilter: [], platformFilter: [] }}
        openPicker
        onRemoveProject={vi.fn<(value: string) => void>()}
        onRemovePlatform={vi.fn<(value: string) => void>()}
      />
    );
    const labels = [
      projects[0]?.displayName,
      projects[1]?.displayName,
      i18n.t('agentChat.sessionFilter.platformCloud'),
    ];
    for (const label of labels) {
      act(() => {
        const checkbox = renderer.root
          .findAllByProps({ accessibilityRole: 'checkbox' })
          .find(row => row.findByType(Text).props.children === label);
        if (!checkbox) {
          throw new Error(`missing checkbox: ${label}`);
        }
        (checkbox.props.onPress as () => void)();
      });
    }
    expect(renderer.root.findByType(SessionFilterChips).findAllByType(ScrollView)).toHaveLength(0);
    act(() => {
      const apply = renderer.root
        .findAllByType(Button)
        .find(button => button.findByType(Text).props.children === i18n.t('common.apply'));
      if (!apply) {
        throw new Error('missing Apply button');
      }
      (apply.props.onPress as () => void)();
    });
    expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
    expect(
      renderer.root.findAllByType(Pressable).map(pill => pill.findByType(Text).props.children)
    ).toEqual(labels);
  });
});
