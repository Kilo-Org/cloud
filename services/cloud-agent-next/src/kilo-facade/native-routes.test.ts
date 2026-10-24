import { describe, expect, it } from 'vitest';
import {
  classifyCollectionPath,
  classifyNativeRoute,
  classifySessionSuffix,
  parseNativeAnswerBody,
  parseNativeCommandBody,
} from './native-routes.js';

const kiloSessionId = 'ses_12345678901234567890123456';

describe('classifyNativeRoute', () => {
  it('maps the session-scoped read suffixes', () => {
    expect(classifySessionSuffix('GET', '/todo')).toEqual({
      kind: 'read',
      operation: { name: 'session.todo' },
      scope: 'session',
    });
    expect(classifySessionSuffix('GET', '/diff')).toMatchObject({
      operation: { name: 'session.diff' },
    });
  });

  it('does not classify a mutating method as a read', () => {
    expect(classifySessionSuffix('POST', '/todo')).toBeNull();
  });

  it('recognizes the command intent and leaves the body empty for parsing', () => {
    expect(classifyNativeRoute('POST', `/session/${kiloSessionId}/command`, kiloSessionId)).toEqual(
      {
        kind: 'command',
        body: { command: '' },
      }
    );
  });

  it('maps collection reads to the directory-scoped selector', () => {
    expect(classifyCollectionPath('GET', '/session/status')).toMatchObject({
      operation: { name: 'session.status' },
      scope: 'collection',
    });
    expect(classifyCollectionPath('GET', '/question')).toMatchObject({
      operation: { name: 'question.list' },
    });
    expect(classifyCollectionPath('GET', '/permission')).toMatchObject({
      operation: { name: 'permission.list' },
    });
  });

  it('classifies question and permission answers by encoded id', () => {
    expect(classifyCollectionPath('POST', '/question/que_1/reply')).toEqual({
      kind: 'answering',
      reply: { action: 'question.reply', questionId: 'que_1', answers: [] },
    });
    expect(classifyCollectionPath('POST', '/question/que_1/reject')).toEqual({
      kind: 'answering',
      reply: { action: 'question.reject', questionId: 'que_1' },
    });
    expect(classifyCollectionPath('POST', '/permission/per_1/reply')).toEqual({
      kind: 'answering',
      reply: { action: 'permission.reply', permissionId: 'per_1', response: 'once' },
    });
  });

  it('rejects unknown native paths instead of proxying them', () => {
    expect(classifyCollectionPath('GET', '/session/status/extra')).toBeNull();
    expect(classifyCollectionPath('POST', '/question/que_1/answer')).toBeNull();
    expect(classifySessionSuffix('GET', '/files')).toBeNull();
  });
});

function request(body: unknown): Request {
  return new Request('http://worker.test/kilo/question/que_1/reply', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('native body parsing', () => {
  it('keeps the question id from the path and takes answers from the body', async () => {
    const route = classifyCollectionPath('POST', '/question/que_1/reply');
    if (route?.kind !== 'answering') throw new Error('expected answering route');
    await expect(parseNativeAnswerBody(request({ answers: [['first']] }), route)).resolves.toEqual({
      ok: true,
      reply: { action: 'question.reply', questionId: 'que_1', answers: [['first']] },
    });
  });

  it('rejects an unsupported reply body', async () => {
    const route = classifyCollectionPath('POST', '/permission/per_1/reply');
    if (route?.kind !== 'answering') throw new Error('expected answering route');
    await expect(parseNativeAnswerBody(request({ reply: 'maybe' }), route)).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('bounds the command body', async () => {
    const body = await parseNativeCommandBody(
      new Request('http://worker.test/kilo/session/ses_1/command', {
        method: 'POST',
        body: JSON.stringify({ command: 'commit', arguments: '-m done' }),
      })
    );
    expect(body).toEqual({
      ok: true,
      body: { command: 'commit', arguments: '-m done' },
    });
  });
});
