import { type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { getHeaderPillWidth } from '@/components/agents/context-usage-display';
import { SessionContextMetrics } from '@/components/agents/session-context-metrics';
import { ScreenHeader } from '@/components/screen-header';
import { Wrench } from '@/components/ui/icons';
import { ICON_TARGET_BOX_CLASS, ICON_TARGET_DP } from '@/lib/a11y/tap-target';
import { type ChatSummary } from '@/lib/chat/store';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

import { BackendSettingsControl } from './backend-settings-sheet';
import { ChatTitle } from './chat-title';

/**
 * The `gap-2` the chat header's trailing cluster keeps between its controls, in
 * dp: 0.5rem at the app's 14pt rem.
 */
const HEADER_CONTROL_GAP = 7;

/**
 * The content width this title needs to stay readable: the chat's name in the
 * 18px header style, which paints "Chat" at 33.5 dp. Below about 40 dp the name
 * can only ellipsize into a glyph or two, so that is the point the header
 * reflows. The header's default reserves the 30px list title's width, which is
 * wider than this screen ever paints.
 *
 * The Beta notice beside the name is not part of this minimum. It is a label
 * about the screen and yields before the name does (`ChatTitle` measures the
 * pair and drops the notice when both cannot fit), so a compact row keeps the
 * name whole and the notice gives up its place.
 */
const CHAT_HEADER_TITLE_MIN_WIDTH = 40;

/**
 * The horizontal space the chat header's row loses before its title, in dp: the
 * header's own `px-4` padding (14 a side), and the back control that shares the
 * title's row — its 48 dp target, pulled 14 dp into the gutter by `-ms-4`, plus
 * the row's `gap-1`. The shared row check reserves the widest list gutter alone,
 * which counts the padding but not the back control, so this header declares
 * what it really loses: the check then reflows where the name stops fitting
 * instead of a whole back control too late.
 */
const CHAT_HEADER_CONTENT_INSET = 2 * 14 + (ICON_TARGET_DP - 14) + 3.5;

type ChatScreenHeaderProps = {
  readonly title: string;
  readonly summary: ChatSummary | undefined;
  readonly onRename: (name: string) => Promise<void>;
  readonly metrics: ComponentProps<typeof SessionContextMetrics>;
  /** A reopened chat resolves before it can report any usage. */
  readonly loading: boolean;
  readonly model: string;
  readonly onSelectProviderModel: (modelId: string) => void;
  /** What the tools control is in right now, in the words its sheet uses. */
  readonly mcpStatusText: string;
  readonly onOpenMcp: () => void;
};

/**
 * The chat's header row: the name it can rename, the context and cost pill, the
 * provider control and the tools control, in the one cluster whose width the
 * header reserves.
 */
export function ChatScreenHeader({
  title,
  summary,
  onRename,
  metrics,
  loading,
  model,
  onSelectProviderModel,
  mcpStatusText,
  onOpenMcp,
}: Readonly<ChatScreenHeaderProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  // The cluster reserves the width it lays out at: the pill at this font scale,
  // plus the two fixed icon boxes beside it and their gaps. The pill's readings
  // are text and grow with the scale, so the reserve follows it; the boxes do
  // not. A window that cannot hold the title beside the whole cluster drops it
  // onto its own row instead of squeezing the title to a lone character.
  const fontScale = useLiveFontScale();
  const headerActionsWidth =
    getHeaderPillWidth(fontScale) + 2 * (ICON_TARGET_DP + HEADER_CONTROL_GAP);
  return (
    <ScreenHeader
      title={title}
      titleContent={
        <ChatTitle
          title={title}
          initialValue={summary?.title ?? ''}
          canRename={summary !== undefined}
          onRename={onRename}
        />
      }
      headerRight={
        <View className="flex-row items-center gap-2">
          <SessionContextMetrics {...metrics} loading={loading} />
          <BackendSettingsControl selectedModel={model} onSelectModel={onSelectProviderModel} />
          <Pressable
            onPress={onOpenMcp}
            accessibilityRole="button"
            accessibilityLabel={t('modelChat.mcp.title')}
            // The header control used to draw an unexplained status dot. The
            // state it stood for is named here and drawn in full by the sheet
            // this control opens.
            accessibilityValue={{ text: mcpStatusText }}
            className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
          >
            <Wrench size={22} color={colors.foreground} />
          </Pressable>
        </View>
      }
      headerRightWidth={headerActionsWidth}
      titleMinWidth={CHAT_HEADER_TITLE_MIN_WIDTH}
      contentInset={CHAT_HEADER_CONTENT_INSET}
      showBackButton
    />
  );
}
