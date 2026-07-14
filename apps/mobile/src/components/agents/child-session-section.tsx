import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Bot, ChevronRight, Loader2 } from 'lucide-react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { type KiloSessionId, type Part, type StoredMessage, type ToolPart } from 'cloud-agent-sdk';

import { SpinningIcon } from '@/components/ui/spinning-icon';
import { Text } from '@/components/ui/text';
import { type ThemeColors, useThemeColors } from '@/lib/hooks/use-theme-colors';

import { MessageErrorBoundary } from './message-error-boundary';
import { isToolPart } from './part-types';

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
};

function getStringProperty(obj: unknown, key: string): string | undefined {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return undefined;
  }
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function getTaskToolSessionId(part: ToolPart): KiloSessionId | undefined {
  if (part.tool !== 'task') {
    return undefined;
  }
  const { state } = part;
  if (state.status === 'running' || state.status === 'completed') {
    return getStringProperty(state.metadata, 'sessionId') as KiloSessionId | undefined;
  }
  return undefined;
}

function findRunningToolInMessage(
  msg: StoredMessage
): { tool: string; context?: string } | undefined {
  for (let j = msg.parts.length - 1; j >= 0; j -= 1) {
    const p = msg.parts[j];
    if (p && isToolPart(p) && (p.state.status === 'running' || p.state.status === 'pending')) {
      return { tool: p.tool, context: getToolContext(p) };
    }
  }
  return undefined;
}

function getCurrentRunningTool(
  messages: StoredMessage[]
): { tool: string; context?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.info.role === 'assistant') {
      const result = findRunningToolInMessage(msg);
      if (result) {
        return result;
      }
    }
  }
  return undefined;
}

function getToolContext(p: ToolPart): string | undefined {
  const input = p.state.input;

  if (p.tool === 'read' || p.tool === 'edit' || p.tool === 'write') {
    const filePath = getStringProperty(input, 'filePath');
    return filePath ? filePath.split('/').pop() : undefined;
  }
  if (p.tool === 'bash') {
    const command = getStringProperty(input, 'command');
    if (!command) {
      return undefined;
    }
    const firstWord = command.split(/\s+/)[0];
    return firstWord && firstWord.length > 20 ? `${firstWord.slice(0, 20)}…` : firstWord;
  }
  if (p.tool === 'glob' || p.tool === 'grep') {
    const pattern = getStringProperty(input, 'pattern');
    return pattern && pattern.length > 25 ? `${pattern.slice(0, 25)}…` : pattern;
  }
  if (p.tool === 'task') {
    const description = getStringProperty(input, 'description');
    return description && description.length > 30 ? `${description.slice(0, 30)}…` : description;
  }
  return undefined;
}

export function ChildSessionSection({
  part,
  childMessages,
  onOpenChildSession,
}: Readonly<ChildSessionSectionProps>) {
  const colors = useThemeColors();

  const description = getStringProperty(part.state.input, 'description');
  const prompt = getStringProperty(part.state.input, 'prompt');
  const subtitle = description ?? (prompt ? truncateText(prompt, 60) : 'task');
  const { status } = part.state;
  const isRunning = status === 'running' || status === 'pending';
  const sessionId = getTaskToolSessionId(part);

  const currentTool = isRunning ? getCurrentRunningTool(childMessages) : undefined;

  const borderColor = getStatusBorderColor(status, colors);

  return (
    <Animated.View
      layout={LinearTransition.duration(200)}
      className="overflow-hidden rounded-r-lg"
      // eslint-disable-next-line react-native/no-inline-styles -- dynamic border color
      style={{ borderLeftWidth: 2, borderLeftColor: borderColor }}
    >
      <Pressable
        className="flex-row items-center gap-2 px-3 py-2 active:bg-secondary"
        onPress={() => {
          if (sessionId) {
            onOpenChildSession(sessionId, subtitle);
          }
        }}
        disabled={!sessionId}
        accessibilityRole="button"
        accessibilityLabel={`${subtitle}, ${status}`}
        accessibilityHint={sessionId ? 'Open subagent session' : undefined}
        accessibilityState={{ disabled: !sessionId }}
      >
        <ChevronRight size={14} color={colors.mutedForeground} />

        {isRunning ? (
          <SpinningIcon icon={Loader2} size={16} color={colors.agentSky} />
        ) : (
          <Bot size={16} color={colors.agentSky} />
        )}

        <View className="flex-1">
          <Text className="text-sm text-foreground" numberOfLines={1}>
            {subtitle}
          </Text>
          {isRunning ? (
            <Text className="text-xs leading-4 text-muted-foreground" numberOfLines={1}>
              {currentTool ? (
                <>
                  <Text className="text-xs leading-4 text-agent-sky">{currentTool.tool}</Text>
                  {currentTool.context ? ` ${currentTool.context}` : ''}
                </>
              ) : (
                ' '
              )}
            </Text>
          ) : null}
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
}: Readonly<{
  message: StoredMessage;
  depth: number;
  getChildMessages: (sessionId: string) => StoredMessage[];
  renderPart: RenderPartFn;
  onOpenChildSession: OpenChildSession;
}>) {
  if (depth >= MAX_NESTING_DEPTH) {
    return <Text className="text-xs text-muted-foreground">Maximum nesting depth reached.</Text>;
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

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
