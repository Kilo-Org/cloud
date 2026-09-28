/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test also reads the pill and its helper module off disk, which is the only place an import-time `Platform` capture is observable */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Href } from 'expo-router';
import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FIX_WITH_KILO_HIT_SLOP } from '@/lib/pr-review/comment-trailing-controls';
import { type PrCommentKind } from '@/lib/pr-review/fix-with-kilo';
import { type ProviderPrRef, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
import { type SharePayload } from '@/lib/share-payload';

import { PrCommentFixWithKilo } from './pr-comment-fix-with-kilo';

// ── Mocks ────────────────────────────────────────────────────────────

const { pushMock, putSharePayloadMock } = vi.hoisted(() => ({
  pushMock: vi.fn((_href: Href | string) => undefined),
  putSharePayloadMock: vi.fn((_payload: SharePayload) => 'share-1'),
}));

/** Mutable `Platform.OS` for the iOS/Android parity cases below. */
const platformState = vi.hoisted(() => ({ OS: 'ios' as string }));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('@/lib/share-payload', () => ({ putSharePayload: putSharePayloadMock }));
vi.mock('react-native', () => ({
  Platform: platformState,
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({ WandSparkles: 'WandSparkles' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));

// The parity matrix below flips `platformState.OS` between two runs of the
// same render, which only sees reads made while rendering. A read captured at
// module scope is taken on the first import — before either run — so both
// snapshots would carry the same value and the fork would pass unseen. These
// two sources are what makes that half observable.
const CTA_SOURCE = readFileSync(join(__dirname, 'pr-comment-fix-with-kilo.tsx'), 'utf8');
const HELPER_SOURCE = readFileSync(
  join(__dirname, '..', '..', '..', 'lib', 'pr-review', 'fix-with-kilo.ts'),
  'utf8'
);

// ── Fixtures ─────────────────────────────────────────────────────────

const GITHUB_REF: ProviderPrRef = {
  platform: 'github',
  owner: 'octocat',
  repo: 'hello',
  number: 7,
};

const GITLAB_REF_WITH_HINT: ProviderPrRef = {
  platform: 'gitlab',
  projectPath: 'group/sub/repo',
  mrIid: 12,
  instanceHint: 'https://gitlab.example.com',
};

const GITLAB_REF_WITHOUT_HINT: ProviderPrRef = {
  platform: 'gitlab',
  projectPath: 'group/sub/repo',
  mrIid: 12,
};

const BITBUCKET_REF: ProviderPrRef = {
  platform: 'bitbucket',
  workspace: 'acme',
  repoSlug: 'api',
  prId: 42,
};

type CtaProps = {
  owner: string;
  repo: string;
  number: number;
  commentId: number;
  kind: PrCommentKind;
};

const baseProps: CtaProps = {
  owner: 'octocat',
  repo: 'hello',
  number: 7,
  commentId: 7,
  kind: 'review',
};

// ── Helpers ──────────────────────────────────────────────────────────

async function renderCta(
  props: Partial<CtaProps> = {},
  scope?: { ref: ProviderPrRef; organizationId: string | null }
): Promise<TestRenderer.ReactTestRenderer> {
  const cta = createElement(PrCommentFixWithKilo, { ...baseProps, ...props });
  const tree: ReactElement = scope ? (
    <ProviderPrScopeProvider value={scope}>{cta}</ProviderPrScopeProvider>
  ) : (
    cta
  );
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    await Promise.resolve();
    renderer = TestRenderer.create(tree);
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

function findPressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'Pressable'
  );
}

function pressCta(renderer: TestRenderer.ReactTestRenderer): void {
  const button = findPressables(renderer)[0];
  if (!button) {
    throw new Error('Fix with Kilo control not found');
  }
  (button.props.onPress as () => void)();
}

describe('PrCommentFixWithKilo', () => {
  beforeEach(() => {
    platformState.OS = 'ios';
    pushMock.mockClear();
    putSharePayloadMock.mockClear();
    putSharePayloadMock.mockReturnValue('share-1');
  });

  it('happy: a GitHub review comment stages the anchored link and opens the composer', async () => {
    const renderer = await renderCta();
    pressCta(renderer);

    const commentUrl = 'https://github.com/octocat/hello/pull/7#discussion_r7';
    expect(putSharePayloadMock).toHaveBeenCalledWith({
      text: `Please address the following PR comment: ${commentUrl}`,
      files: [],
      failedFiles: [],
    });
    expect(pushMock).toHaveBeenCalledWith(
      '/(app)/agent-chat/new?shareId=share-1&prefillRepo=octocat%2Fhello'
    );

    renderer.unmount();
  });

  it('happy: a GitHub conversation comment anchors #issuecomment and carries the organization', async () => {
    const renderer = await renderCta(
      { kind: 'conversation' },
      { ref: GITHUB_REF, organizationId: 'org_1' }
    );
    pressCta(renderer);

    expect(putSharePayloadMock).toHaveBeenCalledWith({
      text: 'Please address the following PR comment: https://github.com/octocat/hello/pull/7#issuecomment-7',
      files: [],
      failedFiles: [],
    });
    expect(pushMock).toHaveBeenCalledWith(
      '/(app)/agent-chat/new?organizationId=org_1&shareId=share-1&prefillRepo=octocat%2Fhello'
    );

    renderer.unmount();
  });

  it('empty: a GitLab MR with no instance hint renders no control at all', async () => {
    const renderer = await renderCta(
      { owner: 'group/sub', repo: 'repo', number: 12, commentId: 12 },
      { ref: GITLAB_REF_WITHOUT_HINT, organizationId: null }
    );

    expect(findPressables(renderer)).toHaveLength(0);

    renderer.unmount();
  });

  it.each([
    {
      platform: 'gitlab',
      ref: GITLAB_REF_WITH_HINT,
      url: 'https://gitlab.example.com/group/sub/repo/-/merge_requests/12#note_12',
      href: '/(app)/agent-chat/new?organizationId=org_1&shareId=share-1',
    },
    {
      platform: 'bitbucket',
      ref: BITBUCKET_REF,
      url: 'https://bitbucket.org/acme/api/pull-requests/42#comment-12',
      href: '/(app)/agent-chat/new?organizationId=org_1&shareId=share-1',
    },
  ])(
    'happy: a $platform comment with a host stages its anchor and no repo prefill',
    async ({ ref, url, href }) => {
      const renderer = await renderCta(
        { owner: 'group/sub', repo: 'repo', number: 12, commentId: 12, kind: 'conversation' },
        { ref, organizationId: 'org_1' }
      );
      pressCta(renderer);

      expect(putSharePayloadMock).toHaveBeenCalledWith({
        text: `Please address the following PR comment: ${url}`,
        files: [],
        failedFiles: [],
      });
      // No `prefillRepo`: the picker only ever matches a GitHub row.
      expect(pushMock).toHaveBeenCalledWith(href);

      renderer.unmount();
    }
  );

  it('exposes the action as a labelled button with the wand icon', async () => {
    const renderer = await renderCta();

    const button = findPressables(renderer)[0];
    expect(button?.props.accessibilityRole).toBe('button');
    expect(button?.props.accessibilityLabel).toBe('Fix with Kilo');
    // The pill renders 23pt tall; 11pt of vertical slop per side carries it
    // past 44pt. The horizontal slop is capped at 2pt so the 10.5pt `gap-3` to
    // the overflow button's 3pt left slop never overlaps.
    expect(button?.props.hitSlop).toEqual(FIX_WITH_KILO_HIT_SLOP);
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'WandSparkles'
      )
    ).toHaveLength(1);
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          (node.type as string) === 'Text' &&
          node.props.children === 'Fix with Kilo'
      )
    ).toHaveLength(1);

    renderer.unmount();
  });

  // One implementation for both platforms: the CTA and its helper module carry
  // NO `Platform.OS` branch, so iOS and Android observe the same control, the
  // same staged payload and the same route.
  //
  // `snapshotOn` flips `platformState.OS` before each of the two runs, so a
  // platform read made while rendering (the pill, `buildFixWithKiloHref`,
  // `fixWithKiloPrefillRepo`) makes the snapshots differ and fails below. The
  // flip cannot see a read captured at module scope: that value is taken on the
  // first import, before either run, so both snapshots would carry the same
  // fork. `keeps no Platform.OS fork on the Fix with Kilo path` covers that
  // half by reading both modules off disk, so a fork in either of them — at
  // either scope — fails.
  //
  // Scenarios cover every provider surface the row can render on, plus the
  // no-CTA case (a GitLab MR with no instance hint), so the parity claim holds
  // for the empty state too.
  describe('platform parity', () => {
    type Scenario = {
      readonly name: string;
      readonly props: Partial<CtaProps>;
      readonly scope: { ref: ProviderPrRef; organizationId: string | null } | undefined;
      /** The row must show no control at all on either platform. */
      readonly rendersNothing?: boolean;
    };

    const matrix: Scenario[] = [
      { name: 'a GitHub review comment', props: {}, scope: undefined },
      {
        name: 'a GitHub conversation comment',
        props: { kind: 'conversation' },
        scope: { ref: GITHUB_REF, organizationId: 'org_1' },
      },
      {
        name: 'a GitLab comment on a hinted instance',
        props: {
          owner: 'group/sub',
          repo: 'repo',
          number: 12,
          commentId: 12,
          kind: 'conversation',
        },
        scope: { ref: GITLAB_REF_WITH_HINT, organizationId: 'org_1' },
      },
      {
        name: 'a GitLab comment with no instance hint',
        props: {
          owner: 'group/sub',
          repo: 'repo',
          number: 12,
          commentId: 12,
          kind: 'conversation',
        },
        scope: { ref: GITLAB_REF_WITHOUT_HINT, organizationId: null },
        rendersNothing: true,
      },
      {
        name: 'a Bitbucket comment',
        props: { owner: 'acme', repo: 'api', number: 42, commentId: 12, kind: 'conversation' },
        scope: { ref: BITBUCKET_REF, organizationId: 'org_1' },
      },
    ];

    async function snapshotOn(os: 'ios' | 'android', scenario: Scenario) {
      platformState.OS = os;
      pushMock.mockClear();
      putSharePayloadMock.mockClear();

      const renderer = await renderCta(scenario.props, scenario.scope);
      const buttons = findPressables(renderer);
      if (buttons.length > 0) {
        pressCta(renderer);
      }

      const snapshot = {
        ctaCount: buttons.length,
        payload: putSharePayloadMock.mock.calls[0]?.[0] ?? null,
        push: pushMock.mock.calls[0]?.[0] ?? null,
        label: buttons[0]?.props.accessibilityLabel ?? null,
        hitSlop: buttons[0]?.props.hitSlop ?? null,
      };
      renderer.unmount();
      return snapshot;
    }

    it.each(matrix)('$name behaves identically on iOS and Android', async scenario => {
      const ios = await snapshotOn('ios', scenario);
      const android = await snapshotOn('android', scenario);

      expect(android).toEqual(ios);

      // Keep the equality above from passing on two empty snapshots.
      if (scenario.rendersNothing) {
        expect(ios.ctaCount).toBe(0);
        expect(ios.payload).toBeNull();
        expect(ios.push).toBeNull();
        return;
      }
      expect(ios.ctaCount).toBe(1);
      expect(ios.payload).not.toBeNull();
      expect(ios.push).not.toBeNull();
    });

    it('keeps no Platform.OS fork on the Fix with Kilo path', () => {
      // The two runs above cannot see an import-time capture, so the path is
      // pinned at the source: with no `Platform` symbol in the pill or its
      // helpers, neither a render-time nor a module-scope read is possible on
      // either platform.
      expect(CTA_SOURCE).not.toMatch(/\bPlatform\b/);
      expect(HELPER_SOURCE).not.toMatch(/\bPlatform\b/);
    });
  });
});
