/**
 * Cloud Chat Page
 *
 * Simple wrapper that exports the CloudChatContainer component.
 * All business logic, hooks, and state management are in CloudChatContainer.
 * All rendering logic is in CloudChatPresentation.
 */

'use client';

import { CloudChatContainer } from './CloudChatContainer';

type CloudChatPageProps = {
  organizationId?: string;
};

/**
 * Main export - renders the cloud chat container
 */
export default function CloudChatPage(props: CloudChatPageProps) {
  return <CloudChatContainer {...props} />;
}

// Named export for compatibility
export { CloudChatPage };
