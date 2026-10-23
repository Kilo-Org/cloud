import { useQueryClient } from '@tanstack/react-query';
import { Component, type ErrorInfo, type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { captureTelemetry } from '@/lib/telemetry/error-sink';

type BoundaryProps = {
  children: ReactNode;
  /** The local recovery action; the owner remounts the boundary through its `key` so the fallback resets. */
  onRetry: () => void;
};

type BoundaryState = {
  hasError: boolean;
};

/** Cap the React component stack before it rides in `extra`. */
const MAX_COMPONENT_STACK_LENGTH = 2000;

/** Fallback fingerprint part for a throw that carries no name or message. */
const UNKNOWN_FINGERPRINT_PART = 'unknown';

/**
 * The reads the Profile stack renders from. Retry invalidates exactly these
 * prefixes, so a throw caused by a payload that settled into a shape the render
 * cannot read is re-fetched instead of re-rendered unchanged.
 */
const PROFILE_QUERY_PREFIXES: readonly (readonly unknown[])[] = [
  [['user']],
  [['organizations']],
  [['kiloPass']],
  [['agentProfiles']],
];

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
 * The fallback keeps the screen chrome the tab's own boundary would otherwise
 * take down with it: the Profile header and the scroll viewport stay mounted
 * inside the tab, so the bottom tab bar (owned by the tabs layout above this
 * stack) is untouched and every other tab stays reachable.
 */
function ProfileStackErrorFallback({ onRetry }: Readonly<{ onRetry: () => void }>) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.profile')} size="large" showBackButton={false} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <QueryError placement="top" onRetry={onRetry} />
      </TabScreenScrollView>
    </View>
  );
}

/**
 * Local render-error boundary for the Profile stack. A throw while a screen of
 * the stack renders (including one produced by a payload a background refetch
 * settled into) has no closer boundary, so it reaches the app's root error
 * boundary: that replaces the app with the full-screen error state — the tab
 * bar and the Profile header disappear — and its retry resets navigation to the
 * initial tab. This boundary degrades the same throw to the screen's own
 * retryable error state and keeps the user on Profile.
 */
class ProfileStackRenderBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
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
          'error.subsystem': 'profile',
          'error.operation': 'render_stack',
        },
        ...(componentStack.length > 0
          ? { extra: { componentStack: truncateComponentStack(componentStack) } }
          : {}),
        fingerprint: [
          'profile',
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
      return <ProfileStackErrorFallback onRetry={this.props.onRetry} />;
    }
    return this.props.children;
  }
}

/**
 * Owns the fallback's retry. A reset remounts the stack through the boundary's
 * key, and the Profile reads are invalidated first so the remount renders from
 * a fresh payload rather than the one that just failed to render.
 */
export function ProfileStackErrorBoundary({ children }: Readonly<{ children: ReactNode }>) {
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    for (const queryKey of PROFILE_QUERY_PREFIXES) {
      void queryClient.invalidateQueries({ queryKey });
    }
    setAttempt(current => current + 1);
  }, [queryClient]);

  return (
    <ProfileStackRenderBoundary key={attempt} onRetry={retry}>
      {children}
    </ProfileStackRenderBoundary>
  );
}
