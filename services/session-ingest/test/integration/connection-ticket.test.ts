import { env, runInDurableObject } from 'cloudflare:test';
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

  it('admits one concurrent consume after repeated inspection', async () => {
    const ticket = await mintTicket('usr_ticket_inspect');
    const { stub, secret } = resolveConnectionTicket(env.CONNECTION_TICKET_DO, ticket)!;
    await expect(Promise.all([stub.inspect(secret), stub.inspect(secret)])).resolves.toEqual([
      { userId: 'usr_ticket_inspect' },
      { userId: 'usr_ticket_inspect' },
    ]);
    const consumed = await Promise.all([stub.consume(secret), stub.consume(secret)]);
    expect(consumed.filter(Boolean)).toEqual([{ userId: 'usr_ticket_inspect' }]);
  });

  it('checks expiry again after a successful inspection', async () => {
    const ticket = await mintTicket('usr_ticket_expire_after_inspect');
    const { stub, secret } = resolveConnectionTicket(env.CONNECTION_TICKET_DO, ticket)!;
    await expect(stub.inspect(secret)).resolves.toEqual({
      userId: 'usr_ticket_expire_after_inspect',
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('ticket', {
        userId: 'usr_ticket_expire_after_inspect',
        secret,
        expiresAt: Date.now() - 1,
      });
    });
    await expect(stub.consume(secret)).resolves.toBeNull();
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
