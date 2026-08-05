import { View } from 'react-native';

import { type AgentMode, ModeSelector } from '@/components/agents/mode-selector';
import { ModelSelector } from '@/components/agents/model-selector';
import { type ModelOption } from '@/lib/hooks/use-available-models';
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
}: Readonly<ChatToolbarProps>) {
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
    </View>
  );
}
