import { type LayoutChangeEvent, View } from 'react-native';

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
  /** When set, an always-present paste button renders at the end of the model chip's line. */
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
  /**
   * Accepted for the new-session and clone callers that used to allow a second
   * chip row (#6349); superseded. The toolbar now stays on one row everywhere —
   * a long model name truncates inside its chip — so this prop has no effect.
   */
  wrap?: boolean;
  /** Forwards the row's layout, e.g. to measure the toolbar height. */
  onLayout?: (event: LayoutChangeEvent) => void;
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
  onLayout,
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
  // The paste button shares the model chip's line. The wrapper grows to fill the
  // width the shrink-0 mode chip leaves; inside it the model chip is the only
  // part that gives up width, so the paste button keeps `shrink-0` and stays on
  // the same line at the row's trailing edge.
  const modelSelectorWithPaste = (
    // `min-w-0` lets the chip shrink below its content width, `shrink` makes the
    // wrapper give up that width (React Native defaults `flexShrink` to 0) and
    // `grow` takes the remaining row width, so the chip truncates and the paste
    // button never needs a line of its own.
    <View className="min-w-0 shrink grow flex-row items-center gap-2">
      {modelSelector}
      {onPaste ? (
        <ComposerPasteButton
          size="sm"
          onPress={onPaste}
          disabled={pasteDisabled}
          className="ml-auto shrink-0"
        />
      ) : null}
    </View>
  );

  return (
    // The row never wraps: it stays one line on both the session and the
    // new-session composer at every width and locale. The mode chip is
    // `shrink-0`, so the model chip takes the remaining width and truncates a
    // long model name ("DeepSeek V4.1 Flash") with its own `numberOfLines={1}`,
    // while the paste button keeps the trailing edge of the same line.
    <View
      onLayout={onLayout}
      className={cn('flex-row items-center gap-2 px-3 py-2.5', disabled && 'opacity-50', className)}
    >
      {order === 'model-first' ? modelSelectorWithPaste : modeSelector}
      {order === 'model-first' ? modeSelector : modelSelectorWithPaste}
    </View>
  );
}
