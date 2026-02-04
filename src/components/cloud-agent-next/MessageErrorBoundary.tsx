'use client';

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class MessageErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: unknown) {
    console.error('[MessageErrorBoundary] Error rendering message:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="bg-destructive/10 border-destructive/50 text-destructive rounded-md border p-3">
            <p className="text-sm font-medium">Failed to render message</p>
            <p className="text-xs opacity-80">{this.state.error?.message}</p>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
