import { resolveConnectionErrorMessage } from '@/components/integrations/connection-error-message';

/**
 * Copy for every code the Slack connect flow can return. Both surfaces that end
 * the flow read it: the integration card, and the app-shell page the in-app
 * browser lands on, so a code that asks for support never reads as retryable.
 */
export const slackConnectionErrorMessages: Record<string, string> = {
  workspace_already_connected:
    'This Slack workspace is already connected to another Kilo account or organization. Disconnect it there before connecting it here.',
  previous_workspace_unconfirmed:
    'Slack could not confirm the move away from the previous workspace, so the connection was not changed. Try again.',
  previous_workspace_unreadable:
    'Kilo could not read the Slack access saved for the previous workspace, so the connection was not changed. Contact support to finish disconnecting it.',
  permission_required:
    'Only organization owners and admins can connect or change the organization Slack integration.',
  organization_access_required:
    'You no longer have access to this organization. Ask an organization owner or admin for access.',
};

/** The copy for one Slack connect error code, or the caller's fallback. */
export function getSlackConnectionErrorMessage(error: string, fallback: string): string {
  return resolveConnectionErrorMessage(slackConnectionErrorMessages, error, fallback);
}
