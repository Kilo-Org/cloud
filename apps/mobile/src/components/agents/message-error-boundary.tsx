import { Component, type ErrorInfo, type ReactNode } from 'react';
import { View } from 'react-native';

import { i18n } from '@/i18n';
import { Text } from '@/components/ui/text';
import { captureTelemetry } from '@/lib/telemetry/error-sink';

type Props = {
  children: ReactNode;
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

export class MessageErrorBoundary extends Component<Props, State> {
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
      // this is the only telemetry the renderer crash produces. Report through
      // the shared sink with the subsystem/operation tags and a component
      // stack; the fingerprint groups the same renderer crash instead of
      // flooding one issue per message.
      const componentStack = errorInfo.componentStack?.trim() ?? '';
      captureTelemetry({
        level: 'error',
        error,
        tags: {
          'error.subsystem': 'agent-message-render',
          'error.operation': 'render_part',
        },
        ...(componentStack.length > 0
          ? { extra: { componentStack: truncateComponentStack(componentStack) } }
          : {}),
        fingerprint: [
          'agent-message-render',
          'render_part',
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
        <View className="rounded-lg border border-danger-tile-border bg-danger-tile-bg px-3 py-2">
          <Text className="text-xs text-destructive">
            {i18n.t('agentChat.messageErrorBoundary.failedToRender')}
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}
