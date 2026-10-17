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
  /**
   * Height of the scrollable form frame the prompt sits in, in points. The
   * prompt yields its minimum height to this frame so the whole card renders
   * above the bottom system bar; omitted or unmeasured keeps the preferred
   * floor.
   */
  frameHeight?: number;
  /**
   * The card's top offset inside that frame, in points, measured by the host.
   * The prompt's own `onLayout` reports `y` relative to the padding-free
   * wrapper that hosts the card (`NewSessionConfigureForm`), so it always reads
   * `0` and cannot see the frame's top gap (the ScrollView content's `pt-4`
   * inset). The fit needs the frame-relative offset, so the host measures the
   * wrapper and passes it here. Omitted or unmeasured keeps `0`, which restores
   * the preferred floor.
   */
  cardTop?: number;
  /**
   * The block directly under the card that must stay inside the frame, in
   * points: the Run on row (`mt-5`, its label, its `mb-2`, and the selector or
   * target line), measured by the host. The frame fit reserves it — keeping a
   * line of air under it — while the input still keeps its floor beside it, so
   * a long draft cannot grow the card over the row. Where whole lines cannot
   * hold both (a phone with the keyboard up), the floor wins and the row
   * scrolls into view. Omitted or unmeasured keeps `0`, which owes nothing
   * below the card.
   */
  belowCardHeight?: number;
  /** True for the Continue clone entry: hides the composer, paperclip, paste, and voice. */
  isCloneEntry?: boolean;
};
