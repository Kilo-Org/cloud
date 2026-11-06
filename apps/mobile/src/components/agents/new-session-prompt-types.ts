import { type RefObject } from 'react';

import { type AgentMode, type ModeOption } from '@/components/agents/mode-normalize';
import {
  type AgentAttachment,
  type AgentAttachmentCandidate,
  type AttachmentMoveDirection,
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
  onMoveAttachment: (id: string, direction: AttachmentMoveDirection) => void;
  onReorderAttachments: (fromIndex: number, toIndex: number) => void;
  onRefetchModels: () => void;
  onPrefillAttachments: (candidates: AgentAttachmentCandidate[]) => Promise<void>;
  shareId?: string;
  voiceInputSettlerRef: RefObject<(() => Promise<boolean>) | null>;
  /** Optional initial prompt text seeded into the uncontrolled input once on mount. */
  initialPrompt?: string;
  /** Scroll viewport height at the keyboard's destination, excluding the pinned footer. */
  frameHeight?: number;
  /** The same viewport with the keyboard closed; the input interpolates between these fits. */
  keyboardClosedFrameHeight?: number;
  /** Card offset inside the scroll content, including its top padding, measured by the host. */
  cardTop?: number;
  /**
   * The lines the input reserves when the frame has room, from
   * `resolveNewSessionPromptLineCount`. A window too short for the form's first
   * screenful takes one line, so the repository picker under it stays visible.
   * Omitted keeps the shared three-line floor.
   */
  lineCount?: number;
  /** Closed-keyboard policy stays fixed while the open-keyboard line count changes. */
  keyboardClosedLineCount?: number;
  /** True for the Continue clone entry: hides the composer, paperclip, paste, and voice. */
  isCloneEntry?: boolean;
  /**
   * Whether the input takes focus when the screen opens, raising the keyboard.
   * The host resolves it (`shouldAutoFocusNewSessionPrompt`): an entry that
   * still needs a repository pick keeps the keyboard down so the repository,
   * Changes, Environment and Advanced Configuration are on the first
   * screenful, and an entry that is already configured keeps the prompt-first
   * typing it always had. Omitted keeps focus, for hosts that have no
   * configuration to hide.
   */
  autoFocusOnMount?: boolean;
};
