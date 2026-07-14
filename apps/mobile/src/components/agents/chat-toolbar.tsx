import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Settings2 } from 'lucide-react-native';

import { ReasoningSettingsModal } from '@/components/agents/reasoning-settings-modal';
import { type AgentMode, ModeSelector } from '@/components/agents/mode-selector';
import { ModelSelector } from '@/components/agents/model-selector';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type ChatToolbarOrder = 'mode-first' | 'model-first';

type ChatToolbarProps = {
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  model: string;
  variant: string;
  modelOptions: ModelOption[];
  onModelSelect: (modelId: string, variant: string) => void;
  disabled?: boolean;
  isLoadingModels?: boolean;
  order?: ChatToolbarOrder;
  className?: string;
  showReasoningSettings?: boolean;
};

export function ChatToolbar({
  mode,
  onModeChange,
  model,
  variant,
  modelOptions,
  onModelSelect,
  disabled = false,
  isLoadingModels = false,
  order = 'mode-first',
  className,
  showReasoningSettings = true,
}: Readonly<ChatToolbarProps>) {
  const colors = useThemeColors();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const modeSelector = <ModeSelector value={mode} onChange={onModeChange} disabled={disabled} />;
  const modelSelector = (
    <ModelSelector
      value={model}
      variant={variant}
      options={modelOptions}
      onSelect={onModelSelect}
      disabled={disabled}
      isLoading={isLoadingModels}
    />
  );

  return (
    <View
      className={cn(
        'flex-row flex-wrap items-center gap-2 px-3 py-2.5',
        disabled && 'opacity-50',
        className
      )}
    >
      {order === 'model-first' ? modelSelector : modeSelector}
      {order === 'model-first' ? modeSelector : modelSelector}
      {showReasoningSettings ? (
        <>
          <Pressable
            onPress={() => {
              if (!disabled) {
                setIsSettingsOpen(true);
              }
            }}
            disabled={disabled}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            className="ml-auto h-8 w-8 items-center justify-center rounded-full active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel="Reasoning settings"
            accessibilityState={{ disabled }}
          >
            <Settings2 size={16} color={colors.mutedForeground} />
          </Pressable>
          <ReasoningSettingsModal
            visible={isSettingsOpen}
            onClose={() => {
              setIsSettingsOpen(false);
            }}
          />
        </>
      ) : null}
    </View>
  );
}
