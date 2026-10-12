import type { Env } from '../env';

type ConnectionTicketNamespace = Pick<
  Env['CONNECTION_TICKET_DO'],
  'newUniqueId' | 'idFromString' | 'get'
>;

/**
 * Create the object and opaque ticket for a new one-use connection ticket.
 *
 * The object uses `newUniqueId`, not `idFromName`: the first access to a named
 * object waits for a global check that no other location created the same
 * name. That check added hundreds of milliseconds to every mint, and its tail
 * went past the web app's fetch budget. The ticket is `<objectId>.<secret>`:
 * the object id routes the consume, and the random secret authorizes it.
 */
export function createConnectionTicket(namespace: ConnectionTicketNamespace) {
  const id = namespace.newUniqueId();
  const secret = crypto.randomUUID();
  return {
    ticket: `${id.toString()}.${secret}`,
    secret,
    getStub: () => namespace.get(id),
  };
}

/** Resolve a ticket from `createConnectionTicket`, or null for a malformed ticket. */
export function resolveConnectionTicket(namespace: ConnectionTicketNamespace, ticket: string) {
  const [objectId, secret, ...rest] = ticket.split('.');
  if (!objectId || !secret || rest.length > 0) {
    return null;
  }
  let id: DurableObjectId;
  try {
    id = namespace.idFromString(objectId);
  } catch {
    return null;
  }
  return { secret, stub: namespace.get(id) };
}
