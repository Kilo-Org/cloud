import { Component, type ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
};

export class MessageErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  // eslint-disable-next-line class-methods-use-this -- React lifecycle requires instance method
  override componentDidCatch(error: Error): void {
    // eslint-disable-next-line no-console -- intentional error logging
    console.warn('MessageErrorBoundary caught:', error.message);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <View className="rounded-lg border border-danger-tile-border bg-danger-tile-bg px-3 py-2">
          <Text className="text-xs text-destructive">Failed to render content</Text>
        </View>
      );
    }
    return this.props.children;
  }
}
