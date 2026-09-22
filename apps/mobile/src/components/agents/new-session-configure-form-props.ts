import { type RefObject } from 'react';

import {
  type NewSessionRepository,
  type RepositoryGroup,
  type RepositoryPlatform,
} from '@/components/agents/new-session-repository-state';
import { type CloudCreateFailure } from '@/components/agents/use-new-session-creator';
import { type AgentMode } from '@/components/agents/mode-selector';
import { type EffectiveAgentProfile } from '@/components/agents/use-effective-agent-profile';
import { type ModeOption } from '@/components/agents/mode-normalize';
import {
  type AgentAttachment,
  type AgentAttachmentCandidate,
  type AttachmentMoveDirection,
} from '@/lib/agent-attachments/use-agent-attachment-upload';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type InstancePickerInstance, type ModelPickerSelection } from '@/lib/picker-bridge';

/**
 * The New session screen body's contract, extracted beside the component so the
 * form file stays under the repo's max-lines cap; the shape is unchanged.
 */
export type NewSessionConfigureFormProps = {
  // Prompt / model / attachments (Cloud Agent only).
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
  shareId: string | undefined;
  voiceInputSettlerRef: RefObject<(() => Promise<boolean>) | null>;
  initialPrompt?: string;
  // Run target.
  showRunOnSelector: boolean;
  runOnInstance: InstancePickerInstance | null;
  instanceList: InstancePickerInstance[];
  isLoadingInstances: boolean;
  isFetchingInstances: boolean;
  onRefreshInstances: () => void;
  onChangeRunOnInstance: (next: InstancePickerInstance | null) => void;
  showInstanceDisconnectedNote: boolean;
  // Launch folder (remote CLI only). `""` means the launch directory.
  folderPath: string;
  onChangeFolderPath: (path: string) => void;
  /** Continue-form inline reason shown under "Run on" (e.g. an incapable CLI or a failed clone/import). */
  runOnInlineNote?: string | null;
  /** True for the Continue clone entry: hides Changes and Environment. */
  isCloneEntry?: boolean;
  // Repository (Cloud Agent only).
  groups: RepositoryGroup[];
  isRetrying: boolean;
  onChangeRepo: (fullName: string) => void;
  onConnectProvider: (platform: RepositoryPlatform) => void;
  onRefreshRepos: () => void;
  repositories: NewSessionRepository[];
  /** Recently used rows, threaded to the picker's "Recently used" section. */
  recents: NewSessionRepository[];
  selectedRepo: string;
  /** The route's organization scope; `undefined` is a personal session. */
  organizationId: string | undefined;
  // Environment profile (Cloud Agent only).
  profile: EffectiveAgentProfile | null;
  isProfileLoading: boolean;
  isProfileError: boolean;
  onRetryProfile: () => void;
  // Commit choice (Cloud Agent only).
  autoCommit: boolean;
  onAutoCommitChange: (next: boolean) => void;
  // Start.
  isSpawningRemote: boolean;
  isStartDisabled: boolean;
  onStartSession: () => void;
  /** The last cloud-create rejection, or null before one. */
  cloudCreateError?: CloudCreateFailure | null;
  /** Re-runs the cloud create with the same draft (the retryable recovery). */
  onRetryCloudCreate?: () => void;
};
