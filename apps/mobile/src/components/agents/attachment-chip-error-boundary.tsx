import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { captureTelemetry } from '@/lib/telemetry/error-sink';

type Props = {
  attachmentId: string;
  filename: string;
  onRemove: (id: string) => void;
  children: ReactNode;
};

type State = {
  hasError: boolean;
};

const MAX_COMPONENT_STACK_LENGTH = 2000;

/** Fingerprint parts stay short so grouping is stable and the event stays small. */
const MAX_FINGERPRINT_PART_LENGTH = 120;

/**
 * Keeps one attachment from taking the composer down with it. A chip that
 * cannot render becomes a compact card that names the failure and removes the
 * file when tapped, so the draft, the input, the other chips and Back stay
 * usable — the alternative was the root error screen, which left Retry as the
 * only way out and dropped the picked photo.
 */
export class AttachmentChipErrorBoundary extends Component<Props, State> {
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
      const componentStack = errorInfo.componentStack?.trim() ?? '';
      const errorName = error instanceof Error ? error.name : '';
      const errorMessage = error instanceof Error ? error.message : '';
      captureTelemetry({
        level: 'error',
        error,
        tags: {
          'error.subsystem': 'agent-attachments',
          'error.operation': 'render_chip',
        },
        ...(componentStack.length > 0
          ? { extra: { componentStack: componentStack.slice(0, MAX_COMPONENT_STACK_LENGTH) } }
          : {}),
        fingerprint: [
          'agent-attachments',
          'render_chip',
          errorName.slice(0, MAX_FINGERPRINT_PART_LENGTH) || 'unknown',
          errorMessage.slice(0, MAX_FINGERPRINT_PART_LENGTH) || 'unknown',
        ],
      });
    } catch {
      // Telemetry must never throw into the render path.
    }
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <View className="relative mr-2">
          <Pressable
            className="h-12 w-48 items-center justify-center rounded-md border border-danger-tile-border bg-danger-tile-bg px-2 active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel={i18n.t('chat.attachment.attachFailed')}
            accessibilityHint={i18n.t('agentChat.attachmentPreview.removeAttachment', {
              filename: this.props.filename,
            })}
            onPress={() => {
              this.props.onRemove(this.props.attachmentId);
            }}
          >
            <Text numberOfLines={2} className="text-center text-[10px] text-destructive">
              {i18n.t('chat.attachment.attachFailed')}
            </Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}
