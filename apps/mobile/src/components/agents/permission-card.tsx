import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, type Text as RNText, ScrollView, View } from 'react-native';
import * as Haptics from 'expo-haptics';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  applyBlockingCardAppearance,
  type BlockingCardSubmissionError,
  formatBlockingCardTitle,
  getBlockingCardPresentationForKind,
} from '@/components/agents/blocking-card-state';
import { announceForA11y, moveA11yFocus } from '@/lib/a11y/announce';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type PermissionCardProps = {
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  onRespond: (response: 'once' | 'always' | 'reject') => void;
  isSubmitting?: boolean;
  /**
   * Identifier for the current blocking request. Drives the on-mount
   * announce + focus effect so a new permission re-announces even if the
   * component instance is reused by React.
   */
  requestId: string;
  /**
   * Optional failure state from a previous response submission. The card
   * derives the rest of the presentation (CTAs, error text) from this via
   * the shared blocking-card-state FSM.
   */
  submissionError?: BlockingCardSubmissionError | null;
  /**
   * Total number of pending blocking requests (questions + permissions).
   * The card title receives a position hint when more than one request waits.
   */
  pendingCount?: number;
};

export function PermissionCard({
  permission,
  patterns,
  metadata,
  onRespond,
  isSubmitting = false,
  requestId,
  submissionError = null,
  pendingCount = 1,
}: Readonly<PermissionCardProps>) {
  const colors = useThemeColors();
  const [activeResponse, setActiveResponse] = useState<'once' | 'always' | 'reject' | null>(null);

  // Accessibility presentation is derived from the shared FSM so the
  // selection logic and CTA flags stay covered by pure-logic tests.
  const presentation = useMemo(
    () => getBlockingCardPresentationForKind({ kind: 'permission', submissionError }),
    [submissionError]
  );

  // The card root wraps interactive controls, so it must NOT be an
  // accessibility element. The focus target is a non-interactive leaf title
  // inside the header; this keeps every Deny/Allow option reachable by
  // VoiceOver while still landing focus on the card when it appears.
  const titleRef = useRef<RNText | null>(null);
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;
  useEffect(
    () =>
      applyBlockingCardAppearance(presentationRef.current, titleRef, {
        announce: announceForA11y,
        focus: moveA11yFocus,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only announce/focus on a new request
    [requestId]
  );

  function handleRespond(response: 'once' | 'always' | 'reject') {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActiveResponse(response);
    onRespond(response);
  }

  // Format permission name for display
  const permissionDisplay = permission
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const title = formatBlockingCardTitle('Permission required', pendingCount);
  const isInert = presentation.state === 'non-retryable';

  // Skill-shell batches accept only once/reject (CLI/TUI show no persist option);
  // never offer Always Allow for them.
  const isSkillShell = metadata?.skillShell === true;

  return (
    <View className="mx-4 my-2 shrink overflow-hidden rounded-xl border border-border bg-card">
      <View className="border-b border-border bg-secondary px-4 py-3">
        <Text ref={titleRef} accessible accessibilityLabel={title} className="text-sm font-medium">
          {title}
        </Text>
        <Text className="mt-1 text-xs text-muted-foreground">
          {presentation.protocolExplanation}
        </Text>
      </View>

      {presentation.errorMessage ? (
        <View className="border-b border-border bg-destructive/10 px-4 py-2">
          <Text className="text-xs text-destructive">{presentation.errorMessage}</Text>
        </View>
      ) : null}

      <ScrollView className="max-h-96 shrink">
        <View className="gap-3 p-4">
          <Text className="text-sm text-foreground">
            Allow <Text className="font-medium">{permissionDisplay}</Text>?
          </Text>

          {patterns.length > 0 ? (
            <View className="gap-1 rounded-lg bg-muted p-2">
              <Text className="text-xs font-medium text-muted-foreground">Applies to:</Text>
              {patterns.map((pattern, index) => (
                <Text key={index} className="text-xs text-muted-foreground">
                  • {pattern}
                </Text>
              ))}
            </View>
          ) : null}

          {metadata && Object.keys(metadata).length > 0 ? (
            <View className="gap-1">
              {Object.entries(metadata).map(([key, value]) => (
                <Text key={key} className="text-xs text-muted-foreground">
                  {key}: {String(value)}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      </ScrollView>

      {presentation.hasPrimaryCta || presentation.hasRetryCta ? (
        <View className="flex-row gap-2 border-t border-border p-3">
          {presentation.hasPrimaryCta ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onPress={() => {
                  handleRespond('reject');
                }}
                disabled={isSubmitting || isInert}
                accessibilityRole="button"
                accessibilityLabel="Deny permission"
              >
                {activeResponse === 'reject' && isSubmitting ? (
                  <ActivityIndicator size="small" color={colors.foreground} />
                ) : (
                  <Text className={cn('text-xs', activeResponse === 'reject' && 'font-medium')}>
                    Deny
                  </Text>
                )}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="flex-1"
                onPress={() => {
                  handleRespond('once');
                }}
                disabled={isSubmitting || isInert}
                accessibilityRole="button"
                accessibilityLabel="Allow once"
              >
                {activeResponse === 'once' && isSubmitting ? (
                  <ActivityIndicator size="small" color={colors.secondaryForeground} />
                ) : (
                  <Text className={cn('text-xs', activeResponse === 'once' && 'font-medium')}>
                    Allow Once
                  </Text>
                )}
              </Button>
              {!isSkillShell ? (
                <Button
                  size="sm"
                  className="flex-1"
                  onPress={() => {
                    handleRespond('always');
                  }}
                  disabled={isSubmitting || isInert}
                  accessibilityRole="button"
                  accessibilityLabel="Always allow"
                >
                  {activeResponse === 'always' && isSubmitting ? (
                    <ActivityIndicator size="small" color={colors.primaryForeground} />
                  ) : (
                    <Text
                      className={cn(
                        'text-xs text-primary-foreground',
                        activeResponse === 'always' && 'font-medium'
                      )}
                    >
                      Always Allow
                    </Text>
                  )}
                </Button>
              ) : null}
            </>
          ) : null}
          {presentation.hasRetryCta ? (
            <Button
              size="sm"
              className="flex-1"
              onPress={() => {
                handleRespond(activeResponse ?? 'once');
              }}
              disabled={isSubmitting || isInert}
              accessibilityRole="button"
              accessibilityLabel="Retry"
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : null}
              <Text className={cn('text-xs text-primary-foreground', isSubmitting && 'ml-2')}>
                {isSubmitting ? 'Retrying…' : 'Retry'}
              </Text>
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
