import { useTranslation } from 'react-i18next';

import { ChatToolbar } from '@/components/agents/chat-toolbar';
import { type AgentMode, type ModeOption } from '@/components/agents/mode-normalize';
import { QueryError } from '@/components/query-error';
import { InputFrame } from '@/components/ui/input-frame';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type ModelPickerSelection } from '@/lib/picker-bridge';

type NewSessionPromptCloneProps = {
  isModelsError: boolean;
  modelOptions: (ModelOption | SessionModelOption)[];
  mode: AgentMode;
  model: string;
  variant: string;
  onModeChange: (mode: AgentMode) => void;
  onModelSelect: (modelId: string, variant: string, pickerSelection?: ModelPickerSelection) => void;
  customOptions?: ModeOption[];
  modelLocked: boolean;
  modelLockLabel?: string;
  isLoadingModels: boolean;
  isCreating: boolean;
  onRefetchModels: () => void;
};

/**
 * Clone-entry fallback of the new-session prompt surface. The Continue form
 * has no composer, so this renders the models error or the model/mode toolbar
 * as a standalone block instead of an empty rounded composer card.
 */
export function NewSessionPromptClone({
  isModelsError,
  modelOptions,
  mode,
  model,
  variant,
  onModeChange,
  onModelSelect,
  customOptions = [],
  modelLocked,
  modelLockLabel,
  isLoadingModels,
  isCreating,
  onRefetchModels,
}: Readonly<NewSessionPromptCloneProps>) {
  const { t } = useTranslation();
  if (isModelsError && modelOptions.length === 0) {
    return (
      <InputFrame className="overflow-hidden">
        <QueryError
          placement="top"
          inset="gutter"
          variant="server"
          title={t('agentChat.newSession.couldNotLoadModels')}
          message={t('organization.boundary.loadErrorMessage')}
          onRetry={() => {
            onRefetchModels();
          }}
        />
      </InputFrame>
    );
  }
  return (
    <InputFrame>
      <ChatToolbar
        modeControl={{ mode, onModeChange, customOptions }}
        model={model}
        variant={variant}
        modelOptions={modelOptions}
        onModelSelect={onModelSelect}
        disabled={isCreating}
        isLoadingModels={isLoadingModels}
        modelLocked={modelLocked}
        modelLockLabel={modelLockLabel}
        wrap
      />
    </InputFrame>
  );
}
