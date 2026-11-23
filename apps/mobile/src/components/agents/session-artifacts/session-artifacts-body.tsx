import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState, StateAction } from '@/components/empty-state';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Archive, Cloud, Download, FileText, RotateCcw, Trash2 } from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';
import { RowFrame } from '@/components/ui/row-frame';
import { RowGroup } from '@/components/ui/row-group';
import { RowIconAction } from '@/components/ui/row-trailing';
import { SectionHeader } from '@/components/ui/section-header';
import { Text } from '@/components/ui/text';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { formatFileSize } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { i18n } from '@/i18n';
import { assertSurfaceFailureHandled } from '@/lib/surface-feedback';

import {
  type WorkspaceArtifactEntry,
  workspaceArtifactFileName,
  type WorkspaceArtifactFolder,
} from './session-artifacts-grouping';

/**
 * What one row's last action reported, kept after the attempt settles. The line
 * is resolved from the kind, so a raw server sentence never reaches the screen.
 */
export type ArtifactFailure =
  | { readonly kind: 'delete-changed'; readonly fileName: string }
  | { readonly kind: 'download-failed'; readonly fileName: string }
  | { readonly kind: 'download-share-failed'; readonly fileName: string };

/** The action running for one row, if any. */
export type ArtifactPending = 'download' | 'delete';

/**
 * The one state the artifacts body paints. A failed read carries whether asking
 * again can succeed: the server answers a refusal the same way on every retry,
 * so that state offers no way out through the list.
 */
export type SessionArtifactsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'load-error'; readonly retryable: boolean }
  | { readonly kind: 'empty'; readonly sandboxNotRunning: boolean }
  | {
      readonly kind: 'loaded';
      readonly groups: readonly WorkspaceArtifactFolder[];
      readonly fileCount: number;
      readonly sandboxNotRunning: boolean;
    };

type SessionArtifactsBodyProps = {
  state: SessionArtifactsState;
  onRetry: () => void;
  onRefresh: () => void;
  /** A refresh is in flight: the action keeps its box and refuses presses. */
  refreshing: boolean;
  onDownload: (entry: WorkspaceArtifactEntry) => void;
  onDelete: (entry: WorkspaceArtifactEntry) => void;
  /** The last action's report for one row, or `null` while it has none. */
  failureOf: (relativePath: string) => ArtifactFailure | null;
  /** The action running for one row, or `null` while it is idle. */
  pendingOf: (relativePath: string) => ArtifactPending | null;
};

/**
 * The saved artifacts of one session, as the sheet paints them: the sandbox
 * notice, the list's state, and its grouped rows, each with the last action's
 * line under the row it was for.
 *
 * It owns no query and no phase of its own — the sheet above decides what the
 * state is and this component paints it. That is what lets the design gate
 * render the same body through a fixture with the props a real session
 * produces, instead of a code path only the fixture takes.
 */
export function SessionArtifactsBody({
  state,
  onRetry,
  onRefresh,
  refreshing,
  onDownload,
  onDelete,
  failureOf,
  pendingOf,
}: Readonly<SessionArtifactsBodyProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  // The count is what the reader came for, so it labels the section once the
  // read knows it. Before that the label names the section instead: a "0 files"
  // over a list that is still loading would be a figure the sheet does not have.
  const fileCountLabel =
    state.kind === 'loaded' || state.kind === 'empty'
      ? t('cloudAgent.artifacts.fileCount', {
          count: state.kind === 'loaded' ? state.fileCount : 0,
        })
      : t('cloudAgent.artifacts.title');
  const sandboxNotRunning =
    (state.kind === 'empty' || state.kind === 'loaded') && state.sandboxNotRunning;

  return (
    <View>
      <SectionHeader
        label={fileCountLabel}
        actionLabel={t('common.refresh')}
        onActionPress={onRefresh}
        actionDisabled={refreshing}
        actionTestID="session-artifacts-refresh"
      />
      <View className="gap-3 pt-2">
        {sandboxNotRunning ? (
          <View className="flex-row items-start gap-2 rounded-md border border-border p-3">
            <Cloud size={16} color={colors.mutedForeground} />
            <Text className="min-w-0 flex-1 text-xs text-muted-foreground">
              {t('cloudAgent.artifacts.sandboxNotRunning')}
            </Text>
          </View>
        ) : null}

        {state.kind === 'loading' ? (
          <View className="min-h-36 flex-row items-center justify-center gap-2">
            <ActivityIndicator />
            <Text className="text-sm text-muted-foreground">
              {t('cloudAgent.artifacts.loading')}
            </Text>
          </View>
        ) : null}

        {state.kind === 'load-error' ? (
          <EmptyState
            placement="static"
            icon={Cloud}
            title={t('cloudAgent.artifacts.loadError')}
            // The retry is offered only where asking again can settle the read;
            // a refusal that repeats keeps the copy as the whole answer.
            action={
              state.retryable ? (
                <StateAction label={t('common.retry')} icon={RotateCcw} onPress={onRetry} />
              ) : undefined
            }
          />
        ) : null}

        {state.kind === 'empty' ? (
          <EmptyState placement="static" icon={Archive} title={t('cloudAgent.artifacts.empty')} />
        ) : null}

        {state.kind === 'loaded'
          ? state.groups.map(folder => (
              <View key={folder.directory} className="gap-2">
                <Text variant="caption" numberOfLines={1} ellipsizeMode="middle">
                  {folder.label}
                </Text>
                <RowGroup leadingTile>
                  {folder.files.map(entry => (
                    <View key={entry.relativePath}>
                      <ArtifactRow
                        entry={entry}
                        pending={pendingOf(entry.relativePath)}
                        onDownload={onDownload}
                        onDelete={onDelete}
                      />
                      <ArtifactFailureLine failure={failureOf(entry.relativePath)} />
                    </View>
                  ))}
                </RowGroup>
              </View>
            ))
          : null}

        {state.kind === 'loaded' && state.groups.length > 0 ? (
          <Text variant="caption">{t('cloudAgent.artifacts.keptUntil')}</Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * One saved file: its name, its size, and the two actions a phone can take on
 * it. The name is the readable form a reader scans; the whole path is the row's
 * spoken name, because a middle ellipsis hides the folder a duplicate file name
 * is told apart by.
 */
function ArtifactRow({
  entry,
  pending,
  onDownload,
  onDelete,
}: Readonly<{
  entry: WorkspaceArtifactEntry;
  pending: ArtifactPending | null;
  onDownload: (entry: WorkspaceArtifactEntry) => void;
  onDelete: (entry: WorkspaceArtifactEntry) => void;
}>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const fileName = workspaceArtifactFileName(entry);
  const busy = pending !== null;
  return (
    <RowFrame
      leading={<IconTile icon={FileText} tint={NEUTRAL_TINT} />}
      trailing={{
        kind: 'nodes',
        nodes: [
          <RowIconAction
            key="download"
            label={t('cloudAgent.artifacts.downloadA11y', { fileName })}
            disabled={busy}
            onPress={() => {
              onDownload(entry);
            }}
          >
            {pending === 'download' ? (
              <ActivityIndicator size={16} color={colors.mutedForeground} />
            ) : (
              <Download size={18} color={colors.mutedForeground} />
            )}
          </RowIconAction>,
          <RowIconAction
            key="delete"
            label={t('cloudAgent.artifacts.deleteA11y', { fileName })}
            disabled={busy}
            onPress={() => {
              onDelete(entry);
            }}
          >
            {pending === 'delete' ? (
              <ActivityIndicator size={16} color={colors.mutedForeground} />
            ) : (
              <Trash2 size={18} color={colors.mutedForeground} />
            )}
          </RowIconAction>,
        ],
      }}
    >
      <Text
        variant="mono"
        numberOfLines={1}
        ellipsizeMode="middle"
        accessibilityLabel={entry.relativePath}
        className="min-w-0 shrink"
      >
        {fileName}
      </Text>
      <Text variant="caption" numberOfLines={1} {...HIDDEN_LABEL_PROPS}>
        {formatFileSize(entry.sizeBytes, i18n.language)}
      </Text>
    </RowFrame>
  );
}

/** The line a row's last action reports, under that row. */
function ArtifactFailureLine({ failure }: Readonly<{ failure: ArtifactFailure | null }>) {
  if (failure === null) {
    return null;
  }
  switch (failure.kind) {
    case 'delete-changed': {
      return (
        <AccessibleStatus
          message={i18n.t('cloudAgent.artifacts.deleteChanged', { fileName: failure.fileName })}
          className="px-4 pb-2 text-xs"
        />
      );
    }
    case 'download-failed': {
      return (
        <AccessibleStatus
          message={i18n.t('cloudAgent.artifacts.downloadError', { fileName: failure.fileName })}
          className="px-4 pb-2 text-xs"
        />
      );
    }
    case 'download-share-failed': {
      return (
        <AccessibleStatus
          message={i18n.t('cloudAgent.artifacts.downloadShareFailed', {
            fileName: failure.fileName,
          })}
          className="px-4 pb-2 text-xs"
        />
      );
    }
    default: {
      return assertSurfaceFailureHandled(failure);
    }
  }
}
