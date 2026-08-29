import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { skipToken, useInfiniteQuery } from '@tanstack/react-query';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useTranslation } from 'react-i18next';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useTRPC } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';
import { withRepositoryAccount } from '@/lib/use-github-repos-refresh';
import { type ResolvedNewSessionRepository } from './new-session-repository-state';
import {
  isProviderLaunchSelectionCurrent,
  type ProviderLaunchSelection,
} from './provider-launch-input';

// The screen owns launch state; the repository section renders it inside the form's scroll view.
export const RepositoryBranchContext = createContext<ReturnType<
  typeof useRepositoryBranchSelection
> | null>(null);

export function useRepositoryBranchSelection(
  repository: ResolvedNewSessionRepository | null,
  accountId: string | undefined,
  organizationId: string | undefined
) {
  const trpc = useTRPC();
  const reference =
    repository?.accountId === accountId &&
    isProviderLaunchSelectionCurrent({
      launchSelection: repository ? { reference: repository.reference } : null,
      accountId,
      organizationId,
    })
      ? repository?.reference
      : undefined;
  const options = organizationId
    ? trpc.organizations.cloudAgentNext.listRepositoryBranches.infiniteQueryOptions(
        reference ? { ...reference, organizationId } : skipToken
      )
    : trpc.cloudAgentNext.listRepositoryBranches.infiniteQueryOptions(reference ?? skipToken);
  const query = useInfiniteQuery({
    ...withRepositoryAccount(options, accountId),
    getNextPageParam: page => page.nextCursor ?? undefined,
    retry: false,
  });
  const key = reference ? repository?.key : undefined;
  const scope = useMemo(
    () => ({ key, accountId, organizationId }),
    [key, accountId, organizationId]
  );
  const current = useRef<typeof scope | null>(scope);
  current.current = scope;
  const [choice, setChoice] = useState<{ scope: typeof scope; branch: string } | null>(null);
  useEffect(() => {
    current.current = scope;
    setChoice(null);
    return () => {
      current.current = null;
    };
  }, [scope]);
  const defaultBranch = query.data?.pages[0]?.defaultBranch;
  useEffect(() => {
    if (choice?.scope !== scope && defaultBranch) {
      setChoice({ scope, branch: defaultBranch });
    }
  }, [choice, scope, defaultBranch]);
  const branches = [
    ...new Set(query.data?.pages.flatMap(page => page.branches.map(branch => branch.name))),
  ];
  const branch = choice?.scope === scope ? choice.branch : defaultBranch;
  const code = readTrpcErrorField(query.error, 'code');
  const connectionRecovery = ['FORBIDDEN', 'UNAUTHORIZED', 'PRECONDITION_FAILED'].includes(
    code ?? ''
  );
  const terminal = connectionRecovery || code === 'NOT_FOUND' || code === 'BAD_REQUEST';
  const valid = Boolean(branch && branches.includes(branch) && !terminal);
  const launchSelection = useMemo<ProviderLaunchSelection | null>(
    () => (reference && branch && valid ? { reference, upstreamBranch: branch } : null),
    [reference, branch, valid]
  );
  let message: string | null = null;
  if (connectionRecovery) {
    message = 'agentChat.newSession.branchAccessDenied';
  } else if (code === 'NOT_FOUND') {
    message = 'agentChat.newSession.repositoryUnavailable';
  } else if (code === 'BAD_REQUEST') {
    message = 'agentChat.newSession.invalidRepositorySelection';
  } else if (query.isError) {
    message = 'agentChat.newSession.couldNotLoadBranches';
  } else if (query.isPending) {
    message = 'agentChat.newSession.loadingBranches';
  } else if (branches.length === 0 && !query.hasNextPage) {
    message = 'agentChat.newSession.noBranches';
  } else if (!valid && (!branch || !query.hasNextPage)) {
    message =
      choice?.scope === scope
        ? 'agentChat.newSession.branchUnavailable'
        : 'agentChat.newSession.defaultBranchUnavailable';
  } else if (query.isFetching) {
    message = 'agentChat.newSession.loadingBranches';
  }
  return {
    repository: reference ? repository : null,
    query,
    branches,
    branch,
    message,
    terminal,
    connectionRecovery,
    launchSelection,
    select: (selected: string) => {
      if (current.current === scope && branches.includes(selected) && !terminal) {
        setChoice({ scope, branch: selected });
      }
    },
  };
}

export function RepositoryBranchSelector({
  disabled,
  onConnect,
  connectLabel,
}: {
  disabled: boolean;
  onConnect: () => void;
  connectLabel: string;
}) {
  const state = useContext(RepositoryBranchContext);
  const { t } = useTranslation();
  const { showActionSheetWithOptions } = useActionSheet();
  const latest = useRef({ state, disabled });
  latest.current = { state, disabled };
  if (!state?.repository) {
    return null;
  }
  const { query, branches, branch, message, terminal, connectionRecovery } = state;
  const busy = query.isFetching;
  const canRefresh = !terminal && (query.isError || (!query.isPending && branches.length === 0));
  return (
    <View className="mt-4 gap-2">
      <Text className="text-sm font-medium text-muted-foreground">
        {t('agentChat.newSession.branch')}
      </Text>
      <Button
        variant="outline"
        className="min-h-12"
        disabled={disabled || branches.length === 0 || terminal}
        accessibilityLabel={t('agentChat.newSession.branch')}
        accessibilityValue={{ text: branch ?? t('agentChat.newSession.selectBranch') }}
        onPress={() => {
          showActionSheetWithOptions(
            {
              title: t('agentChat.newSession.selectBranch'),
              options: [...branches, t('common.cancel')],
              cancelButtonIndex: branches.length,
            },
            index => {
              const selected = index === undefined ? undefined : branches[index];
              if (
                selected &&
                !latest.current.disabled &&
                !latest.current.state?.terminal &&
                latest.current.state?.branches.includes(selected)
              ) {
                state.select(selected);
              }
            }
          );
        }}
      >
        <Text className="shrink">{branch ?? t('agentChat.newSession.selectBranch')}</Text>
      </Button>
      {busy ? <ActivityIndicator accessible={false} /> : null}
      <AccessibleStatus
        message={message ? t(message) : null}
        tone={query.isError ? 'error' : 'status'}
      />
      {connectionRecovery ? (
        <Button className="min-h-12" variant="outline" disabled={disabled} onPress={onConnect}>
          <Text>{connectLabel}</Text>
        </Button>
      ) : null}
      {canRefresh ? (
        <Button
          className="min-h-12"
          variant="outline"
          disabled={disabled || busy}
          onPress={() => {
            void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch());
          }}
        >
          <Text>{t(query.isError ? 'common.retry' : 'common.refresh')}</Text>
        </Button>
      ) : null}
      {query.hasNextPage && !query.isError ? (
        <Button
          className="min-h-12"
          variant="outline"
          disabled={disabled || busy}
          onPress={() => {
            void query.fetchNextPage();
          }}
        >
          <Text>{t('agentChat.newSession.loadMoreBranches')}</Text>
        </Button>
      ) : null}
    </View>
  );
}
