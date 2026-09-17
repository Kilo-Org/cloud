import { createElement, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type PrCommentKind } from '@/lib/pr-review/fix-with-kilo';
import { type ProviderPrRef, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';

import { PrCommentFixWithKilo } from './pr-comment-fix-with-kilo';

// ── Mocks ────────────────────────────────────────────────────────────

const { pushMock, putSharePayloadMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  putSharePayloadMock: vi.fn(() => 'share-1'),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('@/lib/share-payload', () => ({ putSharePayload: putSharePayloadMock }));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/icons', () => ({ WandSparkles: 'WandSparkles' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));

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
    // >=44pt effective target on a ~26pt pill; horizontal slop capped at 2pt
    // so the 12pt gap-3 to the overflow button's hitSlop={8} never overlaps.
    expect(button?.props.hitSlop).toEqual({ top: 10, bottom: 10, left: 2, right: 2 });
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
});
