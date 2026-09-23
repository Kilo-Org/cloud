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
   * Lets the chips wrap onto a second row when their combined intrinsic width
   * exceeds the row (narrow viewports), instead of ellipsizing the selected
   * model name (#6349). On by default; `wrap={false}` pins the chips to one
   * row. The host owns the extra height: the new-session form scrolls and its
   * input floor reserves the measured toolbar height.
   */
  wrap?: boolean;
  /** Forwards the row's layout, e.g. to measure the wrapped height. */
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
  wrap = true,
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
  // The paste button rides with the model chip as one wrap unit. As a sibling
  // of the chips it is the item that overflows the full first line, so it wraps
  // alone onto the next line and strands itself at the far edge with an empty
  // row to its left. Packed, the chip and the button move to the next line
  // together and the button stays at the end of the chip's line.
  const modelSelectorWithPaste = (
    // Content-sized for the wrap decision (grow leaves the basis at auto), so
    // the outer row still sees the chip's real width and wraps the unit instead
    // of squeezing the chip; on its line the unit fills the row and the paste
    // keeps the trailing edge.
    <View className="min-w-0 grow flex-row items-center gap-2">
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
    // The chips reflow instead of shrinking each other: the mode chip is
    // `shrink-0`, so in a nowrap row the only flexible part is the model chip,
    // and a long model name ("DeepSeek V4.1 Flash") collapses to "Dee..." next
    // to the effort badge. Wrapping moves the model chip to its own line, where
    // it has the full row width to show the selected model.
    <View
      onLayout={onLayout}
      className={cn(
        'flex-row items-center gap-2 px-3 py-2.5',
        wrap && 'flex-wrap',
        disabled && 'opacity-50',
        className
      )}
    >
      {order === 'model-first' ? modelSelectorWithPaste : modeSelector}
      {order === 'model-first' ? modeSelector : modelSelectorWithPaste}
    </View>
  );
}
