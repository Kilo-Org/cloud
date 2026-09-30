/**
 * The reader's copy the Durable Object writes through its safe failure
 * projection (services/cloud-agent-next/src/session/safe-failure-projection.ts
 * and the assistant failures it re-exports from src/shared/assistant-failure.ts)
 * plus the lines session-service.ts supplies directly. None of them is raw
 * provider text, so a surface that renders one shows it as-is. A bounded
 * workspace failure appends its detail to the projection line, so a message
 * that starts with one of these plus ": " is the same copy.
 */
const SAFE_FAILURE_MESSAGES = new Set([
  // Generic failure codes.
  'Could not connect to the sandbox',
  'Workspace setup failed',
  'Kilo server failed to start',
  'Agent wrapper failed to start',
  'The message could not be delivered',
  'Session metadata is unavailable',
  'No model was selected',
  'Agent wrapper disconnected',
  'Agent wrapper made no execution progress during the watchdog window',
  'Agent wrapper stopped responding',
  'Agent wrapper failed before processing the message',
  'Assistant request failed',
  'Agent wrapper failed while processing the message',
  'No assistant reply was produced',
  'Assistant request failed: insufficient credits',
  'The message was interrupted by the user',
  'The agent container shut down',
  'The message was interrupted',
  'The message failed',
  // Workspace failure subtypes.
  'Repository clone timed out',
  'Repository checkout timed out',
  'Repository authentication failed',
  'Repository request was rate limited',
  'Repository network request failed',
  'Repository data is corrupt',
  'Repository checkout conflict',
  'Requested repository branch was not found',
  'Workspace setup failed: sandbox storage full',
  'Session import timed out',
  'Session import failed',
  'Setup command timed out',
  'Setup command failed',
  // Classified assistant failures.
  'Assistant request was rate limited',
  'Assistant request failed: model not found',
  'Assistant request was not authorized',
  'Assistant service is unavailable',
  'Assistant request timed out',
  'Assistant request was invalid',
  'The model context limit was exceeded',
  'The model output limit was reached',
  'The model provider blocked the response under its content policy',
  'The model response did not match the required format',
  // Lines session-service.ts supplies as `safeFailureMessage`.
  'GitHub repository authentication failed. Check that the GitHub App is installed and has access to this repository.',
  'GitHub credential service is unavailable. Please try again.',
  'GitHub credential resolution failed. Please try again.',
  // The SDK's autocommit status.
  'Commit failed',
]);

/** True when the message is the Durable Object's reader copy, as-is or with a bounded detail. */
export function isSafeFailureMessage(message: string): boolean {
  if (SAFE_FAILURE_MESSAGES.has(message)) {
    return true;
  }
  for (const safe of SAFE_FAILURE_MESSAGES) {
    if (message.startsWith(`${safe}: `)) {
      return true;
    }
  }
  return false;
}
