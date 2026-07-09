import { useSecurityAgentCommands } from '@/lib/hooks/use-security-agent-commands';

// Mounts the Security Agent background command tracker for a scope (poll,
// invalidate, toast on terminal state) without rendering anything.
export function SecurityAgentCommandObserver({ scope }: Readonly<{ scope: string }>) {
  useSecurityAgentCommands(scope);
  return null;
}
