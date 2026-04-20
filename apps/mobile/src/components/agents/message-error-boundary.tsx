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
        <View className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900 dark:bg-red-950">
          <Text className="text-xs text-red-600 dark:text-red-400">Failed to render content</Text>
        </View>
      );
    }
    return this.props.children;
  }
}
