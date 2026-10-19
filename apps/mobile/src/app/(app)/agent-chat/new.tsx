import { NewSessionScreenBody } from '@/components/agents/new-session-screen-body';
import { NewSessionModelProvider } from '@/components/agents/new-session-model-provider';
import { useNewSessionOrganization } from '@/components/agents/use-new-session-organization';

export default function NewSessionScreen() {
  // The same account the body scopes its create to, so the model catalog and
  // the form never disagree about which account the session belongs to.
  const { organizationId } = useNewSessionOrganization();
  return (
    <NewSessionModelProvider organizationId={organizationId}>
      <NewSessionScreenBody />
    </NewSessionModelProvider>
  );
}
