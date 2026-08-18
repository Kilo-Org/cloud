import { type RefObject } from 'react';

import { type AgentMode, type ModeOption } from '@/components/agents/mode-normalize';
import {
  type AgentAttachment,
  type AgentAttachmentCandidate,
} from '@/lib/agent-attachments/use-agent-attachment-upload';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type ModelPickerSelection } from '@/lib/picker-bridge';

/**
 * Public contract of `NewSessionPrompt`. The prompt surface takes every
 * attachment, model, and voice callback from the route, so the prop list is
 * long enough to read on its own — the component file keeps only the render.
 */
export type NewSessionPromptProps = {
  attachments: AgentAttachment[];
  attachmentMax: number;
  isCreating: boolean;
  isModelsError: boolean;
  isLoadingModels: boolean;
  mode: AgentMode;
  model: string;
  variant: string;
  modelOptions: (ModelOption | SessionModelOption)[];
  onChangeText: (text: string) => void;
  onModeChange: (mode: AgentMode) => void;
  onModelSelect: (modelId: string, variant: string, pickerSelection?: ModelPickerSelection) => void;
  /** Custom mode options shown under the built-ins in the mode picker. */
  customOptions?: ModeOption[];
  /** Locks the model picker to the pinned agent model (Cloud Agent only). */
  modelLocked?: boolean;
  /** Agent name shown in the locked model chip's accessibility label. */
  modelLockLabel?: string;
  onAddAttachment: () => void;
  onRemoveAttachment: (id: string) => void;
  onRetryAttachment: (id: string) => void;
  onRefetchModels: () => void;
  onPrefillAttachments: (candidates: AgentAttachmentCandidate[]) => Promise<void>;
  shareId?: string;
  voiceInputSettlerRef: RefObject<(() => Promise<boolean>) | null>;
  /** Optional initial prompt text seeded into the uncontrolled input once on mount. */
  initialPrompt?: string;
};
