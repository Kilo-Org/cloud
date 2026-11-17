import { Fragment, type ReactElement } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { QueryError } from '@/components/query-error';
import { RepoSelector } from '@/components/agents/repo-selector';
import { RepositoryBranchSelector } from '@/components/agents/repository-branch-selector';
import { CollapsibleSection } from '@/components/security-agent/collapsible-section';
import {
  setConnectCtaCollapsed,
  useCollapsedConnectCtas,
} from '@/lib/hooks/use-collapsed-connect-ctas-preference';
import {
  RepositoryActionRow,
  RepositoryPartialNotice,
  RepositoryRefreshButton,
  RepositoryUnavailableCard,
} from '@/components/agents/repository-card-actions';
import { connectCardOffer, PROVIDER_COPY } from '@/components/agents/repository-provider-copy';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import {
  type NewSessionRepository,
  type RepositoryGroup,
  type RepositoryPlatform,
} from './new-session-repository-state';

type NewSessionRepositorySectionProps = {
  disabled: boolean;
  isRetrying: boolean;
  onChange: (fullName: string) => void;
  onConnect: (platform: RepositoryPlatform) => void;
  /**
   * The provider whose connect flow is running, or null. That provider's own
   * open control shows the busy state, so the network round trip at the start of
   * the flow never reads as an inert tap.
   */
  connectingProvider?: RepositoryPlatform | null;
  onRefreshRepos: () => void;
  repositories: NewSessionRepository[];
  /** Recently used rows for the picker's "Recently used" section. */
  recents: NewSessionRepository[];
  groups: RepositoryGroup[];
  value: string;
  /**
   * The route's organization scope; `undefined` is a personal session. The
   * branch query and the picker's Bitbucket note read it from here, so both
   * match the rows this section was given.
   */
  organizationId: string | undefined;
  /**
   * The Continue clone entry reuses the repository picker but submits through
   * the clone path, which has no `upstreamBranch` field: a branch row there
   * would show a choice the submit silently drops, so it is not rendered.
   */
  isCloneEntry: boolean;
  /**
   * Whether the repository region's final height is known. The branch row and
   * the provider cards wait for it; the picker above them is a fixed-height
   * control and always paints. The form gates the rows below this section on
   * the same signal, so the cards and those rows enter in one commit: a card's
   * height depends on the persisted collapse list and on whether a repository
   * is selected, and painting it first would push every row under it down after
   * the form had settled.
   */
  settled: boolean;
};

/**
 * Provider-aware repository section. One group per provider renders its own
 * empty/error state independently, and the picker trigger always renders,
 * listing every repository plus the Recently used rows. A provider's expanded
 * connect prompt renders only before a repository is selected. Afterwards,
 * compact actions keep other providers reachable without contradicting the
 * completed selection or requiring it to be cleared.
 */
export function NewSessionRepositorySection({
  disabled,
  isRetrying,
  onChange,
  onConnect,
  connectingProvider = null,
  onRefreshRepos,
  repositories,
  recents,
  groups,
  value,
  organizationId,
  isCloneEntry,
  settled,
}: Readonly<NewSessionRepositorySectionProps>) {
  const { t } = useTranslation();
  const { collapsedCtas } = useCollapsedConnectCtas();
  // The organization provider is mounted app-wide, so the route's scope resolves
  // its membership here instead of through a prop. `role` is what decides
  // whether a Bitbucket card can offer its connect action at all.
  const { role } = useOrgBoundary(organizationId);

  const hasRepos = repositories.length > 0;
  const anyLoading = groups.some(group => group.status === 'loading');

  // The picker reports `platform:fullName`; resolve it to the row so the branch
  // selector queries (and keys) the full repository identity. The prefill seeds
  // the same platform-qualified key, so no bare-fullName fallback is needed —
  // one would bind a same-named row on another provider.
  const selectedRepository =
    repositories.find(repository => `${repository.platform}:${repository.fullName}` === value) ??
    null;

  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">
        {t('common.repository')}
      </Text>

      {/*
        The picker renders unconditionally. Its trigger always reserves its
        height and already covers loading ("Loading..."), empty ("Select
        repository") and disabled states, so gating it off (the old
        `hasRepos || anyLoading`) could leave the `Repository` heading as the
        section's only child — a blank void above Start session — while a
        provider query was paused (`isLoading === false`, no data) or a
        connect card was waiting on the persisted-collapse read. The web panel
        renders its repository trigger unconditionally too.
      */}
      <RepoSelector
        value={value}
        repositories={repositories}
        recents={recents}
        isLoading={!hasRepos && anyLoading}
        organizationId={organizationId ?? null}
        onChange={onChange}
        disabled={disabled}
      />

      {settled && !isCloneEntry ? (
        <RepositoryBranchSelector
          repository={selectedRepository}
          organizationId={organizationId}
          disabled={disabled}
        />
      ) : null}

      {settled
        ? groups.map(group => (
            <Fragment key={group.key}>
              {group.notice === 'partial' ? (
                <RepositoryPartialNotice
                  platform={group.key}
                  onRefreshRepos={onRefreshRepos}
                  isRetrying={isRetrying}
                />
              ) : null}
              {renderGroupCard(group)}
            </Fragment>
          ))
        : null}
    </View>
  );

  function renderGroupCard(group: RepositoryGroup): ReactElement | null {
    const platform = group.key;
    switch (group.status) {
      case 'connect': {
        // `rowsUnlisted` separates a first connect from a connected workspace
        // whose answer still asks for a selection or fresh credentials.
        const needsReconnect = group.rowsUnlisted === true;
        const offer = connectCardOffer(platform, role, needsReconnect);
        return selectedRepository === null ? (
          renderConnectCard(platform, needsReconnect)
        ) : (
          <View className="mt-3 gap-2">
            {/* This row has no header, so its first-connect note names the provider
                itself; the reconnect note is provider neutral, so this row states
                that name on the line above instead. */}
            {offer.compactContextKey ? (
              <Text variant="muted">{t(offer.compactContextKey)}</Text>
            ) : null}
            {offer.compactNoteKey ? <Text variant="muted">{t(offer.compactNoteKey)}</Text> : null}
            {offer.offersAction ? renderConnectActions(platform) : renderRefreshOnly()}
          </View>
        );
      }
      case 'connected-empty': {
        return renderConnectedEmptyCard(platform);
      }
      case 'unavailable': {
        return (
          <RepositoryUnavailableCard
            platform={platform}
            onConnect={onConnect}
            isConnecting={connectingProvider === platform}
            onRefreshRepos={onRefreshRepos}
            isRetrying={isRetrying}
          />
        );
      }
      case 'error': {
        return (
          <View className="mt-3">
            <QueryError
              placement="top"
              variant="server"
              title={t(PROVIDER_COPY[platform].errorTitle)}
              message={t('organization.boundary.loadErrorMessage')}
              onRetry={onRefreshRepos}
              // The error row's action is the same provider-list refresh the
              // connect and connected-empty cards offer, so it carries the same
              // name instead of the generic "Retry".
              retryLabel={t('agentChat.newSession.refreshRepositories')}
              isRetrying={isRetrying}
            />
          </View>
        );
      }
      case 'loading': {
        return null;
      }
      case 'repos': {
        return null;
      }
      default: {
        return null;
      }
    }
  }

  function renderConnectCard(
    platform: RepositoryPlatform,
    needsReconnect: boolean
  ): ReactElement | null {
    const copy = PROVIDER_COPY[platform];
    const offer = connectCardOffer(platform, role, needsReconnect);
    return (
      <CollapsibleSection
        className="mt-3 rounded-lg border border-border bg-card"
        contentClassName="gap-3"
        // The connected-but-empty card below is a `p-4` surface, and the two are
        // mutually exclusive states of the same region, so this one keeps that
        // 14 dp inset instead of the section's 10.5 dp default.
        inset="roomy"
        titleClassName="font-semibold"
        title={t(copy.connectTitle)}
        // The card stacks under the repository picker in a scrolling column,
        // and the picker's height settles asynchronously (repos load, the
        // selection changes), while the branch row mounts above the card once a
        // repository is chosen. An animated layout here interpolates the card's
        // frame against a sibling that has already snapped, so it paints over
        // the row above it — the picker's bottom edge or the branch row.
        animateLayout={false}
        expanded={!collapsedCtas.includes(platform)}
        onToggle={() => {
          setConnectCtaCollapsed(platform, !collapsedCtas.includes(platform));
        }}
      >
        <View className="gap-1">
          {copy.connectDescription ? (
            <Text variant="muted">{t(copy.connectDescription)}</Text>
          ) : null}
          {offer.noteKey ? <Text variant="muted">{t(offer.noteKey)}</Text> : null}
        </View>
        {offer.offersAction ? renderConnectActions(platform) : renderRefreshOnly()}
      </CollapsibleSection>
    );
  }

  /**
   * The refresh a connect card keeps when it offers no connect action. The
   * action row owns the same control, so a member who cannot connect still has
   * the provider list's one way to ask again after someone else connects it.
   */
  function renderRefreshOnly(): ReactElement {
    return (
      <View className="flex-row justify-end">
        <RepositoryRefreshButton onRefreshRepos={onRefreshRepos} isRetrying={isRetrying} />
      </View>
    );
  }

  /**
   * The provider's connect action. Callers render it only when
   * `connectCardOffer` offers it: a Bitbucket member without organization
   * billing authority is refused by the server, so the card states that
   * restriction instead of showing a tap that can only fail.
   */
  function renderConnectActions(platform: RepositoryPlatform): ReactElement {
    const copy = PROVIDER_COPY[platform];
    return (
      <RepositoryActionRow
        platform={platform}
        labelKey={selectedRepository === null ? copy.openLabel : copy.connectTitle}
        onConnect={onConnect}
        isConnecting={connectingProvider === platform}
        onRefreshRepos={onRefreshRepos}
        isRetrying={isRetrying}
      />
    );
  }

  function renderConnectedEmptyCard(platform: RepositoryPlatform): ReactElement | null {
    const copy = PROVIDER_COPY[platform];
    return (
      <View className="mt-3 gap-3 rounded-lg border border-border bg-card p-4">
        <View className="gap-1">
          <Text className="text-sm font-semibold text-foreground">{t(copy.connectedTitle)}</Text>
          <Text variant="muted">{t(copy.emptyDescription)}</Text>
        </View>
        <View className="flex-row gap-2">
          <RepositoryRefreshButton onRefreshRepos={onRefreshRepos} isRetrying={isRetrying} />
        </View>
      </View>
    );
  }
}
