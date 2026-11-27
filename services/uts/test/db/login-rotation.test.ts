import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alterLoginPassword,
  type DirectTarget,
  directClientConfig,
} from '../../src/rotation/postgres';
import { scramVerifier } from '../../src/rotation/scram';
import { adminUrl, withAdmin } from './connection';

/**
 * A throwaway login of this file only, so no other suite's UTS login password changes. It defaults
 * to read-only transactions, as the `uts_reader` logins do, which a plain ALTER ROLE would hit.
 */
const LOGIN = 'uts_rotation_probe';
const first = `first-${randomUUID()}`;
const target: DirectTarget = (() => {
  const url = new URL(adminUrl());
  return { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1) };
})();

async function logsIn(password: string): Promise<boolean> {
  const client = new pg.Client({ ...target, user: LOGIN, password });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

beforeAll(async () => {
  await withAdmin(undefined, async client => {
    await client.query(`DROP ROLE IF EXISTS ${LOGIN}`);
    await client.query(`CREATE ROLE ${LOGIN} LOGIN PASSWORD '${await scramVerifier(first)}'`);
    await client.query(`ALTER ROLE ${LOGIN} SET default_transaction_read_only = on`);
  });
});

afterAll(async () => {
  await withAdmin(undefined, client => client.query(`DROP ROLE IF EXISTS ${LOGIN}`));
});

describe('the direct ALTER of the login rotation', () => {
  it('stores a SCRAM verifier that PostgreSQL accepts for the password', async () => {
    expect(await logsIn(first)).toBe(true);
    expect(await logsIn('another')).toBe(false);
  });

  it('changes the password as the login itself, then finds it applied on a second run', async () => {
    const pending = `pending-${randomUUID()}`;
    expect(await alterLoginPassword(target, LOGIN, first, pending)).toEqual({ status: 'altered' });
    expect(await logsIn(pending)).toBe(true);
    expect(await logsIn(first)).toBe(false);
    expect(await alterLoginPassword(target, LOGIN, first, pending)).toEqual({
      status: 'already_applied',
    });
  });

  it('reports a login that neither password opens, and an unreachable server', async () => {
    expect(await alterLoginPassword(target, LOGIN, 'wrong-1', 'wrong-2')).toEqual({
      status: 'auth_failed',
    });
    expect(await alterLoginPassword({ ...target, port: 1 }, LOGIN, 'a', 'b')).toEqual({
      status: 'unreachable',
      detail: 'connection failed',
    });
  });
});

describe('the direct session settings', () => {
  it('never connect to a host other than loopback without verified TLS', () => {
    for (const host of ['db.example.test', '10.0.0.5', '2001:db8::1', 'localhost.example.test']) {
      expect(directClientConfig({ host, port: 5432, database: 'postgres' }, LOGIN).ssl).toEqual({
        rejectUnauthorized: true,
      });
    }
    for (const host of ['127.0.0.1', 'localhost']) {
      expect(directClientConfig({ host, port: 5432, database: 'postgres' }, LOGIN).ssl).toBe(false);
    }
  });
});

/**
 * A loopback server that answers every startup with one authentication request, then records
 * whether the client sent a password message ('p') in reply.
 */
async function authServer(
  request: Buffer
): Promise<{ port: number; passwordSent: () => boolean; close: () => void }> {
  let passwordSent = false;
  const sockets: Socket[] = [];
  const server = createServer(socket => {
    sockets.push(socket);
    let started = false;
    socket.on('data', chunk => {
      if (!started) {
        started = true;
        socket.write(request);
        return;
      }
      if (chunk[0] === 0x70) passwordSent = true;
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    passwordSent: () => passwordSent,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

describe('a server that does not ask for SCRAM-SHA-256', () => {
  it.each([
    ['cleartext', Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 3])],
    ['MD5', Buffer.from([0x52, 0, 0, 0, 12, 0, 0, 0, 5, 1, 2, 3, 4])],
  ])('gets no %s password and is refused', async (_method, request) => {
    const server = await authServer(request);
    try {
      const result = await alterLoginPassword(
        { host: '127.0.0.1', port: server.port, database: 'postgres' },
        LOGIN,
        'current-password',
        'pending-password'
      );
      expect(result).toEqual({ status: 'refused', detail: 'server did not ask for SCRAM-SHA-256' });
      expect(server.passwordSent()).toBe(false);
    } finally {
      server.close();
    }
  });
});
