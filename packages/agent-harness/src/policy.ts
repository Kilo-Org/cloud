import type { Conversation, ToolCall } from './contracts';
import { canonicalizeValidatedInput, type Command } from './commands';

// Origin comes from the command ingress, not an agent-supplied field.
export function commandAdmission(
  command: Command,
  permissionRevision: number,
  origin: 'user' | 'agent'
) {
  if (command.type === 'setPermissionMode' && origin !== 'user') return 'denied';
  const seen =
    command.type === 'sendMessage'
      ? command.permissionRevision
      : command.type === 'setPermissionMode'
        ? command.expectedPermissionRevision
        : permissionRevision;
  return seen === permissionRevision ? 'accept' : 'stale_revision';
}
function callIdentity(call: ToolCall): string {
  const {
    id,
    runId,
    name,
    definitionVersion,
    arguments: input,
    context,
    effect,
    executionTarget,
  } = call;
  return canonicalizeValidatedInput({
    id,
    runId,
    name,
    definitionVersion,
    input,
    context,
    effect,
    executionTarget,
  });
}
export type DispatchPolicy = {
  permissionMode: Conversation['permissionMode'];
  permissionRevision: number;
  expectedPermissionRevision: number;
  authorized: boolean;
  available: boolean;
  clientReady: boolean;
  questionAnswered: boolean;
  // Derive this from a trusted local definition, never from remote annotations.
  trustedRead: boolean;
};
// Compare against the stored call, including its approval and dispatch state, not client replacements.
export function evaluateDispatch(stored: ToolCall, proposed: ToolCall, policy: DispatchPolicy) {
  if (callIdentity(stored) !== callIdentity(proposed)) return 'new_call_required';
  if (stored.state === 'executing' || stored.state === 'settled') return 'already_dispatched';
  if (!policy.authorized) return 'access_revoked';
  if (policy.expectedPermissionRevision !== policy.permissionRevision) return 'stale_revision';
  if (stored.approval?.decision === 'deny') return 'denied';
  if (!policy.available) return 'unavailable_tool';
  if (
    policy.permissionMode === 'ask' &&
    (stored.effect !== 'read' || !policy.trustedRead) &&
    stored.approval?.decision !== 'approve'
  )
    return 'approval';
  if (stored.executionTarget.kind === 'interaction' && !policy.questionAnswered) return 'question';
  if (stored.executionTarget.kind === 'client' && !policy.clientReady) return 'client';
  return 'dispatch';
}
