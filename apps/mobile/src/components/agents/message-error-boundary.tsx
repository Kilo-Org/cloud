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

function truncateComponentStack(componentStack: string): string {
  if (componentStack.length <= MAX_COMPONENT_STACK_LENGTH) {
    return componentStack;
  }
  return `${componentStack.slice(0, MAX_COMPONENT_STACK_LENGTH)}…`;
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
  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
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
        fingerprint: ['agent-message-render', 'render_part', error.name, error.message],
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
