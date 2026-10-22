import { z } from 'zod';
import type { ControlPlaneNativeOperation } from '../shared/control-plane-protocol.js';

/**
 * Classification for the native session routes the VS Code and JetBrains
 * clients exercise beyond the original detail/message/prompt/abort set. Every
 * route is a fixed path shape and an allowlisted native operation; nothing here
 * accepts a caller-supplied URL, path, or method.
 */

const MAX_NATIVE_BODY_BYTES = 256 * 1024;

export type NativeSessionRoute =
  | {
      kind: 'read';
      operation: ControlPlaneNativeOperation;
      /**
       * `session` reads are id-scoped and need no body; `collection` reads
       * (`/session/status`, `/question`, `/permission`) need the directory
       * selector that names the hosted session.
       */
      scope: 'session' | 'collection';
    }
  | {
      kind: 'answering';
      reply:
        | { action: 'question.reply'; questionId: string; answers: string[][] }
        | { action: 'question.reject'; questionId: string }
        | {
            action: 'permission.reply';
            permissionId: string;
            response: 'always' | 'once' | 'reject';
          };
    }
  | {
      kind: 'command';
      body: {
        messageID?: string;
        command: string;
        arguments?: string;
        agent?: string;
        model?: string;
      };
    };

/** `GET /session/{id}/todo` etc. — returns null for an unrecognized suffix. */
export function classifySessionSuffix(method: string, suffix: string): NativeSessionRoute | null {
  if (method === 'GET') {
    switch (suffix) {
      case '/todo':
        return { kind: 'read', operation: { name: 'session.todo' }, scope: 'session' };
      case '/diff':
        return { kind: 'read', operation: { name: 'session.diff' }, scope: 'session' };
      default:
        return null;
    }
  }
  return null;
}

const questionReplyPath = /^\/question\/([^/]+)\/reply$/;
const questionRejectPath = /^\/question\/([^/]+)\/reject$/;
const permissionReplyPath = /^\/permission\/([^/]+)\/reply$/;

/**
 * Non-session native routes. They are addressed by the public directory
 * selector rather than a session id, so the caller must name the hosted session
 * it means and authorization is resolved for exactly that session.
 */
export function classifyCollectionPath(
  method: string,
  kiloPath: string
): NativeSessionRoute | null {
  if (method === 'GET' && kiloPath === '/session/status') {
    return { kind: 'read', operation: { name: 'session.status' }, scope: 'collection' };
  }
  if (method === 'GET' && kiloPath === '/question') {
    return { kind: 'read', operation: { name: 'question.list' }, scope: 'collection' };
  }
  if (method === 'GET' && kiloPath === '/permission') {
    return { kind: 'read', operation: { name: 'permission.list' }, scope: 'collection' };
  }
  if (method === 'POST') {
    const questionReply = questionReplyPath.exec(kiloPath);
    if (questionReply?.[1] !== undefined) {
      return {
        kind: 'answering',
        reply: { action: 'question.reply', questionId: decodeId(questionReply[1]), answers: [] },
      };
    }
    const questionReject = questionRejectPath.exec(kiloPath);
    if (questionReject?.[1] !== undefined) {
      return {
        kind: 'answering',
        reply: { action: 'question.reject', questionId: decodeId(questionReject[1]) },
      };
    }
    const permissionReply = permissionReplyPath.exec(kiloPath);
    if (permissionReply?.[1] !== undefined) {
      return {
        kind: 'answering',
        reply: {
          action: 'permission.reply',
          permissionId: decodeId(permissionReply[1]),
          response: 'once',
        },
      };
    }
  }
  return null;
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function classifyNativeRoute(
  method: string,
  kiloPath: string,
  routePath: string | null
): NativeSessionRoute | null {
  if (routePath !== null) {
    const suffix = kiloPath.slice(`/session/${routePath}`.length);
    if (method === 'POST' && suffix === '/command') {
      return { kind: 'command', body: { command: '' } };
    }
    return classifySessionSuffix(method, suffix);
  }
  return classifyCollectionPath(method, kiloPath);
}

const questionReplyBodySchema = z
  .object({ answers: z.array(z.array(z.string().max(10_000))).max(32) })
  .strict();

const permissionReplyBodySchema = z
  .object({
    reply: z.enum(['always', 'once', 'reject']),
    message: z.string().max(1024).optional(),
  })
  .strict();

const commandBodySchema = z
  .object({
    messageID: z.string().min(1).max(128).optional(),
    command: z.string().min(1).max(256),
    arguments: z.string().max(10_000).optional(),
    agent: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(256).optional(),
  })
  .strict();

export async function readNativeJsonBody(
  request: Request
): Promise<
  { ok: true; value: unknown } | { ok: false; status: number; code: string; message: string }
> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_NATIVE_BODY_BYTES) {
    return {
      ok: false,
      status: 413,
      code: 'KILO_REQUEST_TOO_LARGE',
      message: 'Request body is too large',
    };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'KILO_REQUEST_INVALID',
      message: 'Request body is not readable',
    };
  }
  if (new TextEncoder().encode(text).length > MAX_NATIVE_BODY_BYTES) {
    return {
      ok: false,
      status: 413,
      code: 'KILO_REQUEST_TOO_LARGE',
      message: 'Request body is too large',
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'KILO_REQUEST_INVALID',
      message: 'Request body is not JSON',
    };
  }
}

/** Fills the answer list for a question reply from its body. */
export async function parseNativeAnswerBody(
  request: Request,
  route: Extract<NativeSessionRoute, { kind: 'answering' }>
): Promise<
  | { ok: true; reply: Extract<NativeSessionRoute, { kind: 'answering' }>['reply'] }
  | { ok: false; status: number; code: string; message: string }
> {
  const body = await readNativeJsonBody(request);
  if (!body.ok) return body;
  if (route.reply.action === 'question.reject') return { ok: true, reply: route.reply };
  if (route.reply.action === 'question.reply') {
    const parsed = questionReplyBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return {
        ok: false,
        status: 400,
        code: 'KILO_REQUEST_INVALID',
        message: 'Question reply body is not supported',
      };
    }
    return {
      ok: true,
      reply: {
        action: 'question.reply',
        questionId: route.reply.questionId,
        answers: parsed.data.answers,
      },
    };
  }
  const parsed = permissionReplyBodySchema.safeParse(body.value);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      code: 'KILO_REQUEST_INVALID',
      message: 'Permission reply body is not supported',
    };
  }
  return {
    ok: true,
    reply: {
      action: 'permission.reply',
      permissionId: route.reply.permissionId,
      response: parsed.data.reply,
    },
  };
}

export async function parseNativeCommandBody(
  request: Request
): Promise<
  | { ok: true; body: Extract<NativeSessionRoute, { kind: 'command' }>['body'] }
  | { ok: false; status: number; code: string; message: string }
> {
  const body = await readNativeJsonBody(request);
  if (!body.ok) return body;
  const parsed = commandBodySchema.safeParse(body.value);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      code: 'KILO_REQUEST_INVALID',
      message: 'Command body is not supported',
    };
  }
  return { ok: true, body: parsed.data };
}
