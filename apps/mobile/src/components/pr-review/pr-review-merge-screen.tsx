import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from 'react-native';

import { CenteredState } from '@/components/centered-state';

import { PrFormSheetHeader } from '@/components/pr-review/pr-form-sheet-chrome';
import { QueryError } from '@/components/query-error';
import { PrMergeSheet, providerPrNounKey } from '@/components/pr-review/merge/pr-merge-sheet';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type PrMergeMethod } from '@/lib/pr-review/merge/merge-blocked-reasons';
import { parseParam } from '@/lib/route-params';
import {
  buildPrMergeStateQueryOptions,
  buildPrOverviewQueryOptions,
  providerCapabilitiesIdentity,
  selectProviderCapabilitiesData,
} from '@/lib/pr-review/provider-pr-queries';
import {
  isProviderScopeReady,
  parseProviderPrRoute,
  providerPrRefLabel,
  providerPrTriple,
  useProviderPrScope,
} from '@/lib/pr-review/provider-pr-ref';
import { useTRPC } from '@/lib/trpc';

type Params = {
  owner: string;
  repo: string;
  number: string;
  mode?: string;
  method?: string;
  // Provider route shape (`[platform]/[...identity]/merge`).
  platform?: string;
  identity?: string[] | string;
  instance?: string;
};

const MERGE_METHODS = new Set<PrMergeMethod>(['merge', 'squash', 'rebase']);

/**
 * Merge formSheet route. Reads the PR + mode/method from params, fetches the
 * overview so the sheet has the repo settings + head SHA fence, and mounts the
 * merge sheet. Rendered inside BOTH the GitHub `[number]` layout and the
 * provider `[...identity]` layout (s6): on provider arms the s2/s3 merge
 * state rides along as the confirmation sheet's restrictions list, and the
 * wording follows the connected provider (merge request vs pull request).
 */
export function PrReviewMergeScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const params = useLocalSearchParams<Params>();

  // The provider route carries the identity segments; the GitHub route the
  // plain triple. Exactly one parses — the provider layout redirects a
  // hand-built `/pr-review/github/...` link to the GitHub route.
  const providerRef = useMemo(
    () =>
      parseProviderPrRoute({
        platform: params.platform,
        identity: params.identity,
        instance: params.instance,
      }),
    [params.platform, params.identity, params.instance]
  );
  const providerTriple = providerRef ? providerPrTriple(providerRef) : null;
  const owner = providerTriple ? providerTriple.owner : (parseParam(params.owner) ?? '');
  const repo = providerTriple ? providerTriple.repo : (parseParam(params.repo) ?? '');
  const rawNumber = providerTriple
    ? String(providerTriple.number)
    : (parseParam(params.number) ?? '');
  const number = Number.parseInt(rawNumber, 10);

  const mode = params.mode === 'enable-auto-merge' ? 'enable-auto-merge' : 'merge';
  const method: PrMergeMethod = MERGE_METHODS.has(params.method as PrMergeMethod)
    ? (params.method as PrMergeMethod)
    : 'merge';
  const sheetTitle = (() => {
    if (mode === 'enable-auto-merge') {
      return t('prReview.merge.enableAutoMerge');
    }
    if (providerRef && providerRef.platform !== 'github') {
      return t('prReview.merge.mergeTermTitle', {
        term: t(providerPrNounKey(providerRef.platform)),
      });
    }
    return t('prReview.merge.mergePullRequest');
  })();
  const eyebrow = providerRef ? providerPrRefLabel(providerRef) : `${owner}/${repo}#${rawNumber}`;
  const dismiss = () => {
    router.back();
  };

  // The scope the reads run under: the layout publishes the provider scope in
  // context; the GitHub route falls back to the parsed triple, so the GitHub
  // query key is byte-identical to the pre-s6 one.
  const scope = useProviderPrScope(
    owner && repo && Number.isInteger(number) && number > 0
      ? { owner, repo, number }
      : { owner: '', repo: '', number: 0 }
  );

  const trpc = useTRPC();
  const overviewOptions = useMemo(() => buildPrOverviewQueryOptions(trpc, scope), [trpc, scope]);
  const paramsValid = Boolean(owner) && Boolean(repo) && Number.isInteger(number) && number > 0;
  const pr = useQuery({
    ...overviewOptions,
    enabled: paramsValid && isProviderScopeReady(scope),
  });

  // The auto-merge capability, provider auto-merge arms only: a
  // `supported: false` answer (Bitbucket) renders the capability banner.
  // The GitHub arm keeps its query disabled — it never touches the
  // `providerReview` namespace over the network.
  const needsAutoMergeCapability =
    providerRef !== null && providerRef.platform !== 'github' && mode === 'enable-auto-merge';
  // The options call sits directly in the body and the result is bound
  // before `useQuery`: wrapped in a helper/useMemo closure the linter's
  // inference loses the option type, and passed inline the type-checker's
  // inference collapses every `.data` read. The data itself is read back
  // through the seam's typed selector.
  const capabilitiesOptions = trpc.providerReview.getCapabilities.queryOptions(
    providerCapabilitiesIdentity(scope),
    {
      enabled:
        needsAutoMergeCapability && scope.ref.platform !== 'github' && isProviderScopeReady(scope),
    }
  );
  const capabilitiesQuery = useQuery(capabilitiesOptions);
  const capabilitiesData = selectProviderCapabilitiesData(capabilitiesQuery.data);

  // The s2/s3 merge gate, provider arms only (GitHub's gate derives from the
  // overview DTO in the merge section — the GitHub arm's query registers
  // disabled and never touches the `providerReview` namespace).
  const mergeStateOptions = useMemo(
    () => buildPrMergeStateQueryOptions(trpc, scope),
    [trpc, scope]
  );
  const mergeStateQuery = useQuery(mergeStateOptions);

  // The sheet mounts only once its reads SUCCEED, so its content never shifts
  // and a doomed submit is never offered: loading → content happens in the
  // screen body, not inside the sheet, and an errored provider read keeps the
  // sheet unmounted rather than losing the restrictions list (getMergeState)
  // or the capability banner (getCapabilities).
  const isProviderArm = scope.ref.platform !== 'github';
  const mergeStateReady = !isProviderArm || mergeStateQuery.isSuccess;
  const capabilitiesReady = !needsAutoMergeCapability || capabilitiesQuery.isSuccess;

  if (pr.data && mergeStateReady && capabilitiesReady) {
    return (
      <PrMergeSheet
        owner={owner}
        repoName={repo}
        number={number}
        headSha={pr.data.headSha}
        headRef={pr.data.headRef}
        isCrossRepo={pr.data.isCrossRepo}
        prNodeId={pr.data.prNodeId}
        title={pr.data.title}
        bodyMarkdown={pr.data.bodyMarkdown}
        baseRef={pr.data.baseRef}
        repo={pr.data.repo}
        initialMethod={method}
        mode={mode}
        sheetTitle={sheetTitle}
        eyebrow={eyebrow}
        prRef={providerRef && providerRef.platform !== 'github' ? providerRef : undefined}
        mergeState={isProviderArm ? (mergeStateQuery.data ?? null) : undefined}
        autoMergeCapability={
          needsAutoMergeCapability && capabilitiesData ? capabilitiesData.autoMerge : undefined
        }
        onRefetch={async () => {
          await pr.refetch();
        }}
        onDismiss={dismiss}
      />
    );
  }

  const body: ReactNode =
    pr.isLoading ||
    (isProviderArm && mergeStateQuery.isLoading) ||
    (needsAutoMergeCapability && capabilitiesQuery.isLoading) ? (
      <CenteredState>
        <ActivityIndicator size="small" color={colors.mutedForeground} />
      </CenteredState>
    ) : (
      <QueryError
        variant="server"
        title={t('prReview.merge.loadFailedTitle')}
        onRetry={() => {
          // Retry recovers every read the screen is waiting on: the overview
          // and, on the provider arms, the errored merge gate / capability
          // read — a Retry that refetched only the overview could never
          // clear the failure that kept the sheet from mounting.
          void Promise.all([
            pr.refetch(),
            ...(isProviderArm && mergeStateQuery.isError ? [mergeStateQuery.refetch()] : []),
            ...(needsAutoMergeCapability && capabilitiesQuery.isError
              ? [capabilitiesQuery.refetch()]
              : []),
          ]);
        }}
        isRetrying={
          pr.isFetching ||
          (isProviderArm && mergeStateQuery.isFetching) ||
          (needsAutoMergeCapability && capabilitiesQuery.isFetching)
        }
      />
    );

  return (
    <>
      <PrFormSheetHeader title={sheetTitle} eyebrow={eyebrow} onBack={dismiss} />
      {body}
    </>
  );
}
