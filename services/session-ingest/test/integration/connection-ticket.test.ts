import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createConnectionTicket, resolveConnectionTicket } from '../../src/dos/connection-ticket';

async function mintTicket(userId: string) {
  const { ticket, secret, getStub } = createConnectionTicket(env.CONNECTION_TICKET_DO);
  await getStub().mint({ userId, expiresAt: Date.now() + 60_000, secret });
  return ticket;
}

async function consumeTicket(ticket: string) {
  const resolved = resolveConnectionTicket(env.CONNECTION_TICKET_DO, ticket);
  return resolved ? resolved.stub.consume(resolved.secret) : null;
}

describe('connection ticket integration', () => {
  it('consumes a unique-id ticket exactly once', async () => {
    const ticket = await mintTicket('usr_ticket_once');

    expect(ticket).toMatch(/^[0-9a-f]{64}\.[0-9a-f-]{36}$/);
    await expect(consumeTicket(ticket)).resolves.toEqual({ userId: 'usr_ticket_once' });
    await expect(consumeTicket(ticket)).resolves.toBeNull();
  });

  it('rejects a forged secret for a real object id', async () => {
    const ticket = await mintTicket('usr_ticket_forged');
    const [objectId] = ticket.split('.');

    await expect(consumeTicket(`${objectId}.${crypto.randomUUID()}`)).resolves.toBeNull();
    await expect(consumeTicket(ticket)).resolves.toBeNull();
  });

  it('rejects a legacy UUID ticket and an id from no namespace', async () => {
    await expect(consumeTicket(crypto.randomUUID())).resolves.toBeNull();
    await expect(consumeTicket(`${'0'.repeat(64)}.${crypto.randomUUID()}`)).resolves.toBeNull();
  });
});
