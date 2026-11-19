import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { PrCommentEditSheet } from '@/components/pr-review/discussion/pr-comment-edit-sheet';
import { PrConversationCommentComposer } from '@/components/pr-review/discussion/pr-conversation-comment-composer';
import { PrReviewCommentComposerScreen } from '@/components/pr-review/pr-review-comment-composer-screen';
import { PrReviewFileNavigatorScreen } from '@/components/pr-review/pr-review-file-navigator-screen';
import { PrReviewMergeScreen } from '@/components/pr-review/pr-review-merge-screen';
import { PrReviewReviewSubmitScreen } from '@/components/pr-review/pr-review-review-submit-screen';
import { FeedbackPromptProvider } from '@/components/use-feedback-prompt';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import {
  flushDraft,
  prCommentDraftKey,
  prConversationCommentDraftKey,
  saveDraft,
} from '@/lib/persist/drafts';
import { type PrIdentity } from '@/lib/pr-review/diff-selection-bridge';
import { subscribeFileNavigatorRequest } from '@/lib/pr-review/file-navigator-bridge';
import { LONG_BODY, type PrReviewRouteSurface } from '@/lib/pr-review/pr-review-copy-fixture-route';
import {
  pendingReviewDraftKey,
  PendingReviewProvider,
} from '@/lib/pr-review/pending-review-provider';
import {
  githubPrRef,
  parseProviderPrRoute,
  providerPrRefKey,
  providerPrRefLabel,
  type ProviderPrScope,
  ProviderPrScopeProvider,
  providerPrTriple,
} from '@/lib/pr-review/provider-pr-ref';
import { parseParam, parsePositiveIntParam } from '@/lib/route-params';

// Development-only surfaces the PR-review copy fixture can open as the real
// route SCREENS, not as a re-created body. Each name below is one route file
// under `pr-review/[platform]/[...identity]/` or `pr-review/[owner]/[repo]/
// [number]/`; the fixture mounts that file's component with the same params
// and providers its layout publishes, so a link reaches the screen the app
// navigates to. The fixture's fake read client answers the reads underneath.
//
// The link carries the route params the real screen parses: `owner`/`repo`/
// `number` for the GitHub shape, `platform`/`identity` for the provider shape,
// plus that screen's own params (the composer's `path`/`side`/`line`, the edit
// sheet's `commentId`/`kind`/`body`). `state=long` seeds the long body: the
// edit sheet takes it as its `body` param, the two composers as the durable
// draft they open with.

type RawParams = {
  owner?: string | string[];
  repo?: string | string[];
  number?: string | string[];
  platform?: string | string[];
  identity?: string | string[];
  instance?: string | string[];
  path?: string | string[];
  side?: string | string[];
  line?: string | string[];
  startLine?: string | string[];
  commentId?: string | string[];
  kind?: string | string[];
  body?: string | string[];
  state?: string | string[];
};

/**
 * Seeds one durable draft, then mounts its composer. The draft load runs when
 * the composer mounts, so the write must settle first: a sheet mounted beside
 * the write opens on an empty field and the long state never paints.
 */
function SeededDraft({
  entityKey,
  body,
  children,
}: Readonly<{ entityKey: string; body: string; children: ReactNode }>) {
  const { userId } = useCurrentUserId();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!userId) {
      return;
    }
    void (async () => {
      saveDraft(userId, entityKey, body);
      await flushDraft(userId, entityKey);
      setReady(true);
    })();
  }, [userId, entityKey, body]);
  return userId && ready ? children : null;
}

export function PrReviewRouteFixture({ surface }: Readonly<{ surface: PrReviewRouteSurface }>) {
  const router = useRouter();
  const params = useLocalSearchParams<RawParams>();

  // Exactly one shape parses, like the real routes: the provider layout reads
  // its identity segments, the GitHub layout its triple.
  const ref = useMemo(
    () =>
      parseProviderPrRoute({
        platform: params.platform,
        identity: params.identity,
        instance: params.instance,
      }),
    [params.platform, params.identity, params.instance]
  );
  const triple = useMemo(
    () =>
      ref
        ? providerPrTriple(ref)
        : {
            owner: parseParam(params.owner) ?? '',
            repo: parseParam(params.repo) ?? '',
            number: parsePositiveIntParam(params.number) ?? 0,
          },
    [ref, params.owner, params.repo, params.number]
  );
  const scope = useMemo<ProviderPrScope>(
    () => ({
      ref: ref ?? githubPrRef(triple.owner, triple.repo, triple.number),
      organizationId: null,
    }),
    [ref, triple]
  );
  const isProvider = ref !== null && ref.platform !== 'github';
  // The provider layout publishes the scope; the GitHub layout never does, so
  // the GitHub arm keeps the exact query path it has in the app.
  const draftEntityKey = isProvider
    ? `${pendingReviewDraftKey(triple.owner, triple.repo, triple.number)}@${providerPrRefKey(scope.ref)}`
    : pendingReviewDraftKey(triple.owner, triple.repo, triple.number);
  const eyebrow = isProvider
    ? providerPrRefLabel(scope.ref)
    : `${triple.owner}/${triple.repo}#${triple.number}`;

  // The navigator's row tap dispatches into the `prFileNavSlot` entry the diff
  // list behind it writes in the app. The fixture has no diff list, so it
  // writes that slot itself: the tap reaches a subscriber and the sheet
  // dismisses, instead of the request dying for want of a listener.
  const identity: PrIdentity = useMemo(() => ({ ...triple, ref: scope.ref }), [triple, scope.ref]);
  useEffect(() => {
    if (surface !== 'screen-file-navigator') {
      return undefined;
    }
    return subscribeFileNavigatorRequest(identity, () => {
      // Nothing behind the sheet to scroll: the slot exists so the dispatch
      // is the app's, not a no-op in the producer.
    });
  }, [surface, identity]);

  if (!triple.owner || !triple.repo || triple.number <= 0) {
    return <InvalidRouteState backTo="/(app)/pr-review" />;
  }

  const dismiss = () => {
    router.back();
  };
  const long = parseParam(params.state) === 'long';

  let content: ReactNode = null;
  if (surface === 'screen-conversation-comment') {
    const draftKey = prConversationCommentDraftKey(triple.owner, triple.repo, triple.number);
    content = (
      <SeedShell
        seeds={long}
        entityKey={isProvider ? `${draftKey}@${providerPrRefKey(scope.ref)}` : draftKey}
        body={LONG_BODY}
      >
        <PrConversationCommentComposer
          owner={triple.owner}
          repo={triple.repo}
          number={triple.number}
          {...(isProvider ? { prRef: scope.ref } : {})}
          eyebrow={eyebrow}
          onDismiss={dismiss}
        />
      </SeedShell>
    );
  } else if (surface === 'screen-comment-edit') {
    const commentId = parsePositiveIntParam(params.commentId);
    const kind = parseParam(params.kind, ['review', 'conversation'] as const);
    if (commentId === null || !kind) {
      return <InvalidRouteState backTo="/(app)/pr-review" />;
    }
    content = (
      <PrCommentEditSheet
        owner={triple.owner}
        repo={triple.repo}
        number={triple.number}
        commentId={commentId}
        kind={kind}
        initialBody={parseParam(params.body) ?? ''}
        onDismiss={dismiss}
      />
    );
  } else if (surface === 'screen-comment-composer') {
    const draftKey = prCommentDraftKey(
      triple.owner,
      triple.repo,
      triple.number,
      parseParam(params.path) ?? '',
      parseParam(params.side, ['LEFT', 'RIGHT'] as const) ?? 'RIGHT',
      parsePositiveIntParam(params.line) ?? 0,
      parsePositiveIntParam(params.startLine) ?? undefined
    );
    content = (
      <SeedShell
        seeds={long}
        entityKey={isProvider ? `${draftKey}@${providerPrRefKey(scope.ref)}` : draftKey}
        body={LONG_BODY}
      >
        <PrReviewCommentComposerScreen />
      </SeedShell>
    );
  } else if (surface === 'screen-file-navigator') {
    content = <PrReviewFileNavigatorScreen />;
  } else if (surface === 'screen-merge') {
    content = <PrReviewMergeScreen />;
  } else {
    content = <PrReviewReviewSubmitScreen />;
  }

  const withProviders = (
    <FeedbackPromptProvider>
      <PendingReviewProvider userId="review-copy-fixture" draftEntityKey={draftEntityKey}>
        {content}
      </PendingReviewProvider>
    </FeedbackPromptProvider>
  );
  return isProvider ? (
    <ProviderPrScopeProvider value={scope}>{withProviders}</ProviderPrScopeProvider>
  ) : (
    withProviders
  );
}

/**
 * Mounts a composer over a seeded draft, and mounts it bare when the surface
 * asks for the empty (happy) field.
 */
function SeedShell({
  seeds,
  entityKey,
  body,
  children,
}: Readonly<{ seeds: boolean; entityKey: string; body: string; children: ReactNode }>) {
  return seeds ? (
    <SeededDraft entityKey={entityKey} body={body}>
      {children}
    </SeededDraft>
  ) : (
    children
  );
}
