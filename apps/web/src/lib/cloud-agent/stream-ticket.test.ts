import jwt from 'jsonwebtoken';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { signPreviewTicket, signStreamTicket } from './stream-ticket';

type DecodedTicket = jwt.JwtPayload & {
  type: string;
  purpose?: string;
  userId: string;
  cloudAgentSessionId: string;
  organizationId?: string;
  port?: number;
};

function decode(ticket: string): DecodedTicket {
  return jwt.decode(ticket) as DecodedTicket;
}

describe('signPreviewTicket', () => {
  it('mints a 60s preview entry ticket with the preview audience', () => {
    const before = Math.floor(Date.now() / 1000);
    const { ticket, expiresAt } = signPreviewTicket({
      userId: 'user_1',
      cloudAgentSessionId: 'workspace_1',
      port: 5173,
    });

    const decoded = decode(ticket);
    expect(decoded.aud).toBe('cloud-agent-preview');
    expect(decoded.purpose).toBe('preview');
    expect(decoded.port).toBe(5173);
    expect(decoded.userId).toBe('user_1');
    expect(decoded.cloudAgentSessionId).toBe('workspace_1');
    expect(decoded.organizationId).toBeUndefined();
    expect(decoded.exp).toBeDefined();
    expect(decoded.iat).toBeDefined();
    expect(decoded.exp! - decoded.iat!).toBe(60);
    expect(decoded.exp).toBeGreaterThanOrEqual(before + 60);
    expect(expiresAt).toBe(decoded.exp);

    expect(() =>
      jwt.verify(ticket, NEXTAUTH_SECRET, {
        algorithms: ['HS256'],
        audience: 'cloud-agent-preview',
      })
    ).not.toThrow();
    expect(() =>
      jwt.verify(ticket, NEXTAUTH_SECRET, {
        algorithms: ['HS256'],
        audience: 'cloud-agent-stream',
      })
    ).toThrow();
  });

  it('carries the organization when one is supplied', () => {
    const { ticket } = signPreviewTicket({
      userId: 'user_1',
      cloudAgentSessionId: 'workspace_1',
      port: 5173,
      organizationId: 'org_1',
    });

    expect(decode(ticket).organizationId).toBe('org_1');
  });
});

describe('signStreamTicket', () => {
  it('keeps the stream audience for explicit and unspecified stream purposes', () => {
    const explicit = decode(
      signStreamTicket({ purpose: 'stream', userId: 'u', cloudAgentSessionId: 's' }).ticket
    );
    const defaulted = decode(signStreamTicket({ userId: 'u', cloudAgentSessionId: 's' }).ticket);

    expect(explicit.aud).toBe('cloud-agent-stream');
    expect(defaulted.aud).toBe('cloud-agent-stream');
  });

  it('keeps the terminal audience and the 60s default TTL for terminal tickets', () => {
    const { ticket } = signStreamTicket({
      purpose: 'terminal',
      userId: 'u',
      cloudAgentSessionId: 's',
      ptyId: 'pty_1',
    });

    const decoded = decode(ticket);
    expect(decoded.aud).toBe('cloud-agent-terminal');
    expect(decoded.purpose).toBe('terminal');
    expect(decoded.exp! - decoded.iat!).toBe(60);
  });
});
