import {
  CloudAgentFailureCodeSchema,
  isWorkspaceFailureSubtype,
  userVisibleFailureMessage,
  workspaceFailureUserMessage,
} from '@kilocode/worker-utils/cloud-agent-failure';

/**
 * Some failure paths carry a bare classification code such as
 * `workspace_setup_failed` instead of its sentence. A known code reads as the
 * shared user-facing sentence; any other message is returned unchanged.
 */
export function readableSessionError(message: string): string {
  const trimmed = message.trim();
  if (isWorkspaceFailureSubtype(trimmed)) return workspaceFailureUserMessage(trimmed);
  const code = CloudAgentFailureCodeSchema.safeParse(trimmed);
  return code.success ? userVisibleFailureMessage(code.data) : message;
}
