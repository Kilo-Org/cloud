import { type RefObject, useCallback, useRef } from 'react';
import { type ModelSelection } from '@kilocode/cloud-agent-sdk';

import { type AgentMode } from '@/components/agents/mode-selector';
import { useRemoteSpawnDispatch } from '@/components/agents/use-remote-spawn-dispatch';
import { type AgentAttachment } from '@/lib/agent-attachments/agent-attachment-types';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { buildComposerSharePayload } from '@/lib/share-submit-params';

type InstancesRefetch = () => Promise<{
  data: { instances: InstancePickerInstance[] } | undefined;
}>;

type UseNewSessionShareRemoteArgs = {
  organizationId: string | undefined;
  /** Current new-session agent mode, passed through to the spawn dispatch. */
  mode: AgentMode;
  runOnInstance: InstancePickerInstance | null;
  setRunOnInstance: (next: InstancePickerInstance | null) => void;
  refetchInstances: InstancesRefetch;
  instanceList: InstancePickerInstance[];
  /** Live composer draft owned by `useNewSessionCreator`. */
  promptRef: RefObject<string>;
  /** Live attachment list owned by `useAgentAttachmentUpload`. */
  attachments: AgentAttachment[];
  /**
   * The validated wire model selection for the active target, derived by the
   * route from the new-session model view. Undefined means "let the CLI use
   * its default".
   */
  selection?: ModelSelection;
};

/**
 * Wires remote spawn dispatch for the new-session screen and gives it a
 * press-time snapshot of the composer, so a spawned CLI session receives the
 * same text and files through the existing share prefill path.
 */
export function useNewSessionShareRemote({
  organizationId,
  mode,
  runOnInstance,
  setRunOnInstance,
  refetchInstances,
  instanceList,
  promptRef,
  attachments,
  selection,
}: UseNewSessionShareRemoteArgs) {
  // Render-time ref assignment, the same pattern `share-prefill.ts:80` and
  // `share-gate-sheet.tsx:91` use, so the snapshot callback stays stable
  // while always reading the current list.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const getSubmitPayload = useCallback(
    () =>
      buildComposerSharePayload({
        text: promptRef.current,
        attachments: attachmentsRef.current,
      }),
    [promptRef]
  );

  const remoteSpawn = useRemoteSpawnDispatch({
    organizationId,
    mode,
    selection,
    runOnInstance,
    setRunOnInstance,
    refetchInstances,
    instanceList,
    getSubmitPayload,
  });

  return { remoteSpawn, handleRunOnInstanceChange: remoteSpawn.onChangeRunOnInstance };
}
