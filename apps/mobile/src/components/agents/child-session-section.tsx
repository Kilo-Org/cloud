import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { Bot, Loader2 } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import Animated, { LinearTransition } from 'react-native-reanimated';
import {
  type KiloSessionId,
  type Part,
  type StoredMessage,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';

import { SpinningIcon } from '@/components/ui/spinning-icon';
import { Text } from '@/components/ui/text';
import { type ThemeColors, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import {
  type ChildSessionCardState,
  getChildSessionActivityLabel,
  getChildSessionCardState,
  getTaskToolSessionId,
} from './child-session-card-state';
import { getChildSessionModelLabel } from './child-session-model';
import { ChildSessionModelLabel } from './child-session-model-label';
import { MessageErrorBoundary } from './message-error-boundary';
import { isToolPart } from './part-types';

export { getTaskToolSessionId } from './child-session-card-state';

const MAX_NESTING_DEPTH = 5;

export type RenderPartFn = (props: {
  part: Part;
  getChildMessages?: (sessionId: string) => StoredMessage[];
  onOpenChildSession?: OpenChildSession;
}) => ReactNode;

export type OpenChildSession = (sessionId: KiloSessionId, title: string) => void;

type ChildSessionSectionProps = {
  part: ToolPart;
  childMessages: StoredMessage[];
  onOpenChildSession: OpenChildSession;
  modelOptions?: SessionModelOption[];
};

export function ChildSessionSection({
  part,
  childMessages,
  onOpenChildSession,
  modelOptions,
}: Readonly<ChildSessionSectionProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();

  const { agentName, taskName, latestActivity }: ChildSessionCardState = getChildSessionCardState(
    part,
    childMessages
  );
  const latestActivityLabel = getChildSessionActivityLabel(latestActivity);
  const modelLabel = getChildSessionModelLabel(childMessages, modelOptions ?? []);

  const { status } = part.state;
  const isRunning = status === 'running' || status === 'pending';
  const sessionId = getTaskToolSessionId(part);

  const borderColor = getStatusBorderColor(status, colors);

  return (
    <Animated.View
      layout={LinearTransition.duration(200)}
      className="overflow-hidden rounded-lg"
      // eslint-disable-next-line react-native/no-inline-styles -- dynamic border color
      style={{ borderStartWidth: 2, borderStartColor: borderColor }}
    >
      <Pressable
        className="flex-row items-center gap-2 px-3 py-2 active:bg-secondary"
        onPress={() => {
          if (sessionId) {
            onOpenChildSession(sessionId, taskName);
          }
        }}
        disabled={!sessionId}
        accessibilityRole="button"
        accessibilityLabel={t('agentChat.childSession.accessibilityLabel', {
          agentName,
          taskName,
          modelLabel: modelLabel ? `, ${modelLabel}` : '',
          latestActivityLabel,
          status,
        })}
        accessibilityHint={sessionId ? t('agentChat.childSession.openHint') : undefined}
        accessibilityState={{ disabled: !sessionId }}
      >
        <DirectionalChevronRight size={14} color={colors.mutedForeground} />

        {isRunning ? (
          <SpinningIcon icon={Loader2} size={16} color={colors.agentSky} />
        ) : (
          <Bot size={16} color={colors.agentSky} />
        )}

        <View className="flex-1">
          <Text className="text-xs leading-4 text-agent-sky" numberOfLines={1}>
            {agentName}
          </Text>
          <Text className="text-sm leading-5 text-foreground" numberOfLines={1}>
            {taskName}
          </Text>
          {modelLabel ? <ChildSessionModelLabel modelLabel={modelLabel} /> : null}
          <Text className="text-xs leading-4 text-muted-foreground" numberOfLines={1}>
            {
              // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ChildSessionActivity has no discriminant field to narrow on, and `'tool' in latestActivity` would throw for the string variant.
              typeof latestActivity === 'string' ? (
                latestActivity
              ) : (
                <>
                  <Text className="text-xs leading-4 text-agent-sky">{latestActivity.tool}</Text>
                  {latestActivity.context ? ` ${latestActivity.context}` : ''}
                </>
              )
            }
          </Text>
        </View>

        <StatusBadge status={status} />
      </Pressable>
    </Animated.View>
  );
}

export function ChildSessionMessage({
  message,
  depth,
  getChildMessages,
  renderPart,
  onOpenChildSession,
  modelOptions,
}: Readonly<{
  message: StoredMessage;
  depth: number;
  getChildMessages: (sessionId: string) => StoredMessage[];
  renderPart: RenderPartFn;
  onOpenChildSession: OpenChildSession;
  modelOptions?: SessionModelOption[];
}>) {
  const { t } = useTranslation();

  if (depth >= MAX_NESTING_DEPTH) {
    return (
      <Text className="text-xs text-muted-foreground">
        {t('agentChat.childSession.maxNestingDepth')}
      </Text>
    );
  }

  return (
    <View className="gap-1 rounded-md bg-secondary p-2">
      {message.parts.map(p => {
        if (isToolPart(p) && p.tool === 'task') {
          const nestedSessionId = getTaskToolSessionId(p);
          const nestedMessages = nestedSessionId ? getChildMessages(nestedSessionId) : [];

          return (
            <ChildSessionSection
              key={p.id}
              part={p}
              childMessages={nestedMessages}
              onOpenChildSession={onOpenChildSession}
              modelOptions={modelOptions}
            />
          );
        }

        return (
          <MessageErrorBoundary key={p.id}>
            {renderPart({ part: p, getChildMessages, onOpenChildSession })}
          </MessageErrorBoundary>
        );
      })}
    </View>
  );
}

function getStatusBorderColor(status: string, colors: ThemeColors): string {
  if (status === 'error') {
    return colors.destructive;
  }
  if (status === 'completed') {
    return colors.good;
  }
  return colors.info;
}

function StatusBadge({ status }: Readonly<{ status: string }>) {
  const bgClass = getStatusBgClass(status);
  const textClass = getStatusTextClass(status);

  return (
    <View className={`rounded px-1.5 py-0.5 ${bgClass}`}>
      <Text className={`text-xs ${textClass}`}>{status}</Text>
    </View>
  );
}

function getStatusBgClass(status: string): string {
  if (status === 'completed') {
    return 'bg-good-tile-bg';
  }
  if (status === 'error') {
    return 'bg-danger-tile-bg';
  }
  return 'bg-info-tile-bg';
}

function getStatusTextClass(status: string): string {
  if (status === 'completed') {
    return 'text-good';
  }
  if (status === 'error') {
    return 'text-destructive';
  }
  return 'text-info';
}
