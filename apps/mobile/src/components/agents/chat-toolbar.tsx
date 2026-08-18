import { View } from 'react-native';

import { ComposerPasteButton } from '@/components/agents/composer-paste-button';
import { type AgentMode, ModeSelector } from '@/components/agents/mode-selector';
import { type ModeOption } from '@/components/agents/mode-normalize';
import { ModelSelector } from '@/components/agents/model-selector';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type ModelPickerSelection } from '@/lib/picker-bridge';
import { cn } from '@/lib/utils';

type ChatToolbarOrder = 'mode-first' | 'model-first';

type ChatToolbarProps = {
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  model: string;
  variant: string;
  modelOptions: (ModelOption | SessionModelOption)[];
  onModelSelect: (modelId: string, variant: string, pickerSelection?: ModelPickerSelection) => void;
  disabled?: boolean;
  isLoadingModels?: boolean;
  order?: ChatToolbarOrder;
  /** When set, an always-present paste button renders at the row's trailing edge. */
  onPaste?: () => void;
  /** Disabled state for the paste button; the composer's input rule owns it. */
  pasteDisabled?: boolean;
  /** Custom mode options shown under the built-ins in the mode picker. */
  customOptions?: ModeOption[];
  /** Locks the model picker to the pinned agent model (Cloud Agent only). */
  modelLocked?: boolean;
  /** Agent name shown in the locked model chip's accessibility label. */
  modelLockLabel?: string;
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
  onPaste,
  pasteDisabled = false,
  customOptions = [],
  modelLocked = false,
  modelLockLabel,
  className,
}: Readonly<ChatToolbarProps>) {
  const modeSelector = (
    <ModeSelector
      value={mode}
      onChange={onModeChange}
      disabled={disabled}
      customOptions={customOptions}
    />
  );
  const modelSelector = (
    <ModelSelector
      value={model}
      variant={variant}
      options={modelOptions}
      onSelect={onModelSelect}
      disabled={disabled || modelLocked}
      isLoading={isLoadingModels}
      lockLabel={modelLocked ? modelLockLabel : undefined}
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
      {onPaste ? (
        <ComposerPasteButton
          size="sm"
          onPress={onPaste}
          disabled={pasteDisabled}
          className="ml-auto"
        />
      ) : null}
    </View>
  );
}
