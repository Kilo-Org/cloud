export async function fetchStreamTicket(
  sessionId: string,
  organizationId?: string
): Promise<{ ticket: string; expiresAt: number }> {
  const body: { cloudAgentSessionId: string; organizationId?: string } = {
    cloudAgentSessionId: sessionId,
  };
  if (organizationId) {
    body.organizationId = organizationId;
  }
  const response = await fetch('/api/cloud-agent-next/sessions/stream-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorData = (await response.json()) as { error?: string };
    throw new Error(errorData.error ?? 'Failed to get stream ticket');
  }
  const result = (await response.json()) as { ticket?: string; expiresAt?: number };
  if (result.ticket === undefined) {
    throw new Error('Missing ticket in stream-ticket response');
  }
  if (result.expiresAt === undefined) {
    throw new Error('Missing expiresAt in stream-ticket response');
  }
  return { ticket: result.ticket, expiresAt: result.expiresAt };
}
