import { withDeadline } from '@kilocode/event-service';
import { useQueryClient } from '@tanstack/react-query';
import { Component, type ErrorInfo, type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { captureTelemetry } from '@/lib/telemetry/error-sink';

/**
 * Bound on the recovery refetch. A read that cannot settle (a query paused
 * while the device has no usable connection) must not leave the fallback's
 * Retry spinning: the stack remounts when the deadline lands and the refetch
 * continues in the background.
 */
const RECOVERY_REFETCH_DEADLINE_MS = 10_000;

/** Cap the React component stack before it rides in `extra`. */
const MAX_COMPONENT_STACK_LENGTH = 2000;

/** Fallback fingerprint part for a throw that carries no name or message. */
const UNKNOWN_FINGERPRINT_PART = 'unknown';

type TabStackBoundaryProps = {
  titleKey: string;
  subsystem: string;
  queryPrefixes: readonly (readonly unknown[])[];
  children: ReactNode;
  /** The local recovery action; the owner remounts the boundary through its `key` so the fallback resets. */
  onRetry: () => void;
  /** Whether the recovery refetch is in flight, so the fallback's action shows progress. */
  isRetrying: boolean;
};

type BoundaryState = {
  hasError: boolean;
};

export type TabStackErrorBoundaryProps = {
  /**
   * i18n key of the header this tab renders. It stays above the inline error so
   * the tab keeps its own chrome while the stack recovers.
   */
  titleKey: string;
  /** Telemetry subsystem tag for the tab, e.g. `profile` or `agents`. */
  subsystem: string;
  /** Every tRPC root the tab's screens render; the retry refetches these. */
  queryPrefixes: readonly (readonly unknown[])[];
  children?: ReactNode;
};

function truncateComponentStack(componentStack: string): string {
  if (componentStack.length <= MAX_COMPONENT_STACK_LENGTH) {
    return componentStack;
  }
  return `${componentStack.slice(0, MAX_COMPONENT_STACK_LENGTH)}…`;
}

/**
 * Fingerprint parts for whatever the child threw: React hands
 * `componentDidCatch` the raw thrown value, which is not necessarily an
 * `Error`. A non-Error throw groups under one stable signature; the raw value
 * still rides on the event.
 */
function fingerprintPart(error: unknown, part: 'name' | 'message'): string {
  if (!(error instanceof Error)) {
    return UNKNOWN_FINGERPRINT_PART;
  }
  const value = error[part];
  return value.length > 0 ? value : UNKNOWN_FINGERPRINT_PART;
}

/**
 * The fallback keeps the screen chrome the root boundary would otherwise take
 * down with it: the tab's own header and scroll viewport stay mounted inside
 * the tab, so the bottom tab bar (owned by the tabs layout above the stacks)
 * is untouched and every other tab stays reachable.
 */
function TabStackErrorFallback({
  titleKey,
  onRetry,
  isRetrying,
}: Readonly<{ titleKey: string; onRetry: () => void; isRetrying: boolean }>) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t(titleKey)} size="large" showBackButton={false} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <QueryError placement="top" onRetry={onRetry} isRetrying={isRetrying} />
      </TabScreenScrollView>
    </View>
  );
}

/**
 * Local render-error boundary for one tab's stack. A throw while a screen of the
 * stack renders (including one produced by a payload a background refetch
 * settled into) has no closer boundary, so it reaches the app's root error
 * boundary: that replaces the app with the full-screen error state — the tab
 * bar and the tab's header disappear — and its retry resets navigation to the
 * initial tab. This boundary degrades the same throw to the screen's own
 * retryable error state and keeps the person on the tab they chose.
 */
class TabStackRenderBoundary extends Component<TabStackBoundaryProps, BoundaryState> {
  constructor(props: TabStackBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  // eslint-disable-next-line class-methods-use-this -- React lifecycle requires instance method
  override componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    try {
      // A boundary stops the error from reaching Sentry's global handler, so
      // this is the only telemetry the crash produces.
      const componentStack = errorInfo.componentStack?.trim() ?? '';
      captureTelemetry({
        level: 'error',
        error,
        tags: {
          'error.subsystem': this.props.subsystem,
          'error.operation': 'render_stack',
        },
        ...(componentStack.length > 0
          ? { extra: { componentStack: truncateComponentStack(componentStack) } }
          : {}),
        fingerprint: [
          this.props.subsystem,
          'render_stack',
          fingerprintPart(error, 'name'),
          fingerprintPart(error, 'message'),
        ],
      });
    } catch {
      // Telemetry must never throw into the render path.
    }
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <TabStackErrorFallback
          titleKey={this.props.titleKey}
          onRetry={this.props.onRetry}
          isRetrying={this.props.isRetrying}
        />
      );
    }
    return this.props.children;
  }
}

/**
 * Owns the fallback's retry. The tab's reads are refetched before the boundary
 * is remounted: bumping the key in the same tick would mount the fresh boundary
 * against the very cached payload that just threw, so it would throw again and
 * pin the fallback through the refetch. Only the prefixes the tab's screens
 * read are refetched, so a crash on one tab never bursts the rest of the app's
 * cache; inactive observers are included, so a screen that unmounted with the
 * throw is refreshed too.
 */
export function TabStackErrorBoundary({
  titleKey,
  subsystem,
  queryPrefixes,
  children,
}: Readonly<TabStackErrorBoundaryProps>) {
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const retry = useCallback(() => {
    setIsRetrying(true);
    void (async () => {
      try {
        await withDeadline(RECOVERY_REFETCH_DEADLINE_MS, async () => {
          await Promise.all(
            queryPrefixes.map(queryKey => queryClient.refetchQueries({ queryKey, type: 'all' }))
          );
        });
      } catch {
        // A read that cannot settle inside the deadline must not leave Retry
        // spinning; the remount below still rebinds the stack to its reads.
      } finally {
        setIsRetrying(false);
        setAttempt(current => current + 1);
      }
    })();
  }, [queryClient, queryPrefixes]);

  return (
    <TabStackRenderBoundary
      key={attempt}
      titleKey={titleKey}
      subsystem={subsystem}
      queryPrefixes={queryPrefixes}
      onRetry={retry}
      isRetrying={isRetrying}
    >
      {children}
    </TabStackRenderBoundary>
  );
}
