import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetHeader } from '@/components/sheet-header';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';

import { SessionArtifactsBody, type SessionArtifactsState } from './session-artifacts-body';
import {
  groupWorkspaceArtifactsByFolder,
  type WorkspaceArtifactEntry,
} from './session-artifacts-grouping';
import { SessionPageSheet } from '../session-page-sheet';

/** The states the design gate opens this fixture in. */
const SESSION_ARTIFACTS_FIXTURE_STATES = [
  'loaded',
  'empty',
  'loading',
  'load-error',
  'terminal-error',
  'sandbox-not-running',
  'delete-changed',
] as const;

export type SessionArtifactsFixtureState = (typeof SESSION_ARTIFACTS_FIXTURE_STATES)[number];

export function isSessionArtifactsFixtureState(
  value: string | undefined
): value is SessionArtifactsFixtureState {
  return SESSION_ARTIFACTS_FIXTURE_STATES.some(state => state === value);
}

/**
 * What one file's hash is in this fixture. The contract wants 64 hex characters,
 * and the digits are the file's own index: two entries never carry the same
 * hash, because the delete action's `expectedHash` is what tells them apart.
 */
function fixtureHash(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

/** A saved file as the worker lists it. */
function fixtureEntry(
  relativePath: string,
  sizeBytes: number,
  seed: number
): WorkspaceArtifactEntry {
  return {
    relativePath,
    contentHash: fixtureHash(seed),
    sizeBytes,
    contentType: 'application/octet-stream',
    updatedAt: 1_767_225_600_000 + seed * 60_000,
  };
}

/** The files a session that saved a report, its notes and one chart holds. */
const SESSION_ARTIFACTS_FIXTURE_ENTRIES: readonly WorkspaceArtifactEntry[] = [
  fixtureEntry('reports/summary.pdf', 1_400_000, 1),
  fixtureEntry('reports/notes.md', 3_000, 2),
  fixtureEntry('charts/q4.png', 812_000, 3),
];

/**
 * The artifacts sheet's body in one state, for the design gate. The sheet itself
 * needs a session and a live worker; this renders the same body the sheet
 * renders, with the props a real session produces, so the fixture adds no code
 * path of its own.
 *
 * Open it through its dev fixture path (`dev/session-artifacts-fixture/<state>`),
 * which `src/app/+native-intent.tsx` maps to the route. A release build
 * redirects away.
 */
export function SessionArtifactsFixture({
  state,
}: Readonly<{ state: SessionArtifactsFixtureState }>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const groups = groupWorkspaceArtifactsByFolder(
    SESSION_ARTIFACTS_FIXTURE_ENTRIES,
    t('cloudAgent.artifacts.title')
  );
  const failingPath = 'reports/summary.pdf';
  const loaded = (sandboxNotRunning: boolean): SessionArtifactsState => ({
    kind: 'loaded',
    groups,
    fileCount: SESSION_ARTIFACTS_FIXTURE_ENTRIES.length,
    sandboxNotRunning,
  });
  const bodyState: SessionArtifactsState = (() => {
    switch (state) {
      case 'loading': {
        return { kind: 'loading' };
      }
      case 'load-error': {
        return { kind: 'load-error', retryable: true };
      }
      case 'terminal-error': {
        return { kind: 'load-error', retryable: false };
      }
      case 'empty': {
        return { kind: 'empty', sandboxNotRunning: false };
      }
      case 'sandbox-not-running': {
        return loaded(true);
      }
      case 'delete-changed':
      case 'loaded': {
        return loaded(false);
      }
      default: {
        return { kind: 'loading' };
      }
    }
  })();
  const changed = state === 'delete-changed';
  return (
    <SessionPageSheet visible onClose={() => undefined} dismissible>
      <SheetHeader
        title={t('cloudAgent.artifacts.title')}
        onDone={() => undefined}
        topInset="ios-page-sheet"
      />
      <ScrollView className="flex-1" contentContainerClassName={cn(SCREEN_BODY_CLASS, 'pb-6')}>
        <SessionArtifactsBody
          state={bodyState}
          onRetry={() => undefined}
          onRefresh={() => undefined}
          refreshing={false}
          onDownload={() => undefined}
          onDelete={() => undefined}
          failureOf={relativePath =>
            changed && relativePath === failingPath
              ? { kind: 'delete-changed', fileName: 'summary.pdf' }
              : null
          }
          pendingOf={() => null}
        />
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
    </SessionPageSheet>
  );
}
