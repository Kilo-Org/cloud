import { describe, expect, it, vi } from 'vitest';
import { createConnectionTicket, resolveConnectionTicket } from './connection-ticket';

const OBJECT_ID = 'a'.repeat(64);

function makeNamespace() {
  const stub = { consume: vi.fn(), mint: vi.fn() };
  return {
    stub,
    namespace: {
      newUniqueId: vi.fn(() => OBJECT_ID),
      idFromString: vi.fn((id: string) => {
        if (!/^[0-9a-f]{64}$/.test(id)) throw new TypeError('Invalid Durable Object ID');
        return id;
      }),
      get: vi.fn(() => stub),
    },
  };
}

type Namespace = ReturnType<typeof makeNamespace>['namespace'];

// The middleware maps a null resolution to the same 401 as a failed consume,
// so only a direct call shows which guard rejected the ticket.
function resolve(namespace: Namespace, ticket: string) {
  return resolveConnectionTicket(namespace as never, ticket);
}

describe('createConnectionTicket', () => {
  it('builds an opaque ticket from a unique id and a secret, and keeps the id for the stub', () => {
    const { namespace, stub } = makeNamespace();

    const created = createConnectionTicket(namespace as never);

    expect(namespace.newUniqueId).toHaveBeenCalledTimes(1);
    expect(created.ticket).toMatch(new RegExp(`^${OBJECT_ID}\\.[0-9a-f-]{36}$`));
    expect(created.ticket.endsWith(`.${created.secret}`)).toBe(true);
    expect(created.secret).not.toBe('');
    created.getStub();
    expect(namespace.get).toHaveBeenCalledWith(OBJECT_ID);
    expect(stub).toBeDefined();
  });
});

describe('resolveConnectionTicket', () => {
  it('returns the secret and the stub for a well-formed ticket', () => {
    const { namespace } = makeNamespace();
    const ticket = `${OBJECT_ID}.secret-value`;

    const resolved = resolve(namespace, ticket);

    expect(resolved).not.toBeNull();
    expect(resolved?.secret).toBe('secret-value');
    expect(resolved?.stub).toBeDefined();
    expect(namespace.get).toHaveBeenCalledWith(OBJECT_ID);
  });

  it('rejects a ticket without a dot (missing secret)', () => {
    const { namespace } = makeNamespace();

    expect(resolve(namespace, crypto.randomUUID())).toBeNull();
    expect(namespace.idFromString).not.toHaveBeenCalled();
  });

  it('rejects a ticket with an empty secret', () => {
    const { namespace } = makeNamespace();

    expect(resolve(namespace, `${OBJECT_ID}.`)).toBeNull();
  });

  it('rejects a ticket with extra segments', () => {
    const { namespace } = makeNamespace();

    expect(resolve(namespace, `${OBJECT_ID}.secret.extra`)).toBeNull();
    expect(namespace.idFromString).not.toHaveBeenCalled();
  });

  it('rejects an object id the namespace does not accept', () => {
    const { namespace } = makeNamespace();

    expect(resolve(namespace, `not-an-object-id.${crypto.randomUUID()}`)).toBeNull();
    expect(namespace.idFromString).toHaveBeenCalledWith('not-an-object-id');
    expect(namespace.get).not.toHaveBeenCalled();
  });
});
