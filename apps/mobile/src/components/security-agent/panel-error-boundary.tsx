import { Component, type ErrorInfo, type ReactNode } from 'react';

import { QueryError } from '@/components/query-error';
import { captureTelemetry } from '@/lib/telemetry/error-sink';

type Props = {
  children: ReactNode;
  /** The local recovery action (refetch the panel's query). The parent remounts the boundary through its `key` so the fallback resets. */
  onRetry: () => void;
  /** Overrides the fallback's i18n key (the Remediation tab passes its own couldNotLoad copy). */
  fallbackMessage?: string;
};

type State = {
  hasError: boolean;
};

/**
 * Cap the React component stack before it rides in `extra`: a pathological
 * render tree must not bloat the telemetry event.
 */
const MAX_COMPONENT_STACK_LENGTH = 2000;

/** Fallback fingerprint part for a throw that carries no name or message. */
const UNKNOWN_FINGERPRINT_PART = 'unknown';

function truncateComponentStack(componentStack: string): string {
  if (componentStack.length <= MAX_COMPONENT_STACK_LENGTH) {
    return componentStack;
  }
  return `${componentStack.slice(0, MAX_COMPONENT_STACK_LENGTH)}…`;
}

/**
 * Fingerprint parts for whatever the child threw. React hands
 * `componentDidCatch` the raw thrown value, which is not necessarily an
 * `Error`: `error.name` throws on a `null` throw (dropping the event entirely)
 * and reads `undefined` on a string one (an unusable fingerprint). A non-Error
 * throw groups under one stable signature; the raw value still rides on the
 * event.
 */
function fingerprintName(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return UNKNOWN_FINGERPRINT_PART;
}

function fingerprintMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return UNKNOWN_FINGERPRINT_PART;
}

/**
 * Local render-error boundary for the finding detail's Analysis and
 * Remediation panel bodies. A throw in a panel's render (an unexpected
 * analysis payload shape reaching the markdown/HTML render path) has no
 * closer boundary and would otherwise reach the app's root error boundary,
 * which replaces the whole app with the global error screen and drops the
 * open finding. This boundary degrades to the panel's own retryable error
 * state — the screen header, the tabs, and the finding stay mounted.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  // eslint-disable-next-line class-methods-use-this -- React lifecycle requires instance method
  override componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    try {
      // A boundary stops the error from reaching Sentry's global handler, so
      // this is the only telemetry the panel crash produces. Report through
      // the shared sink with the subsystem/operation tags and a component
      // stack; the fingerprint groups the same panel crash.
      const componentStack = errorInfo.componentStack?.trim() ?? '';
      captureTelemetry({
        level: 'error',
        error,
        tags: {
          'error.subsystem': 'security-agent-finding-detail',
          'error.operation': 'render_panel',
        },
        ...(componentStack.length > 0
          ? { extra: { componentStack: truncateComponentStack(componentStack) } }
          : {}),
        fingerprint: [
          'security-agent-finding-detail',
          'render_panel',
          fingerprintName(error),
          fingerprintMessage(error),
        ],
      });
    } catch {
      // Telemetry must never throw into the render path.
    }
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <QueryError
          message={this.props.fallbackMessage ?? 'securityAgent.analysis.couldNotLoad'}
          onRetry={this.props.onRetry}
        />
      );
    }
    return this.props.children;
  }
}
