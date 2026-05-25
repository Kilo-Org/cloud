import {
  rewriteFreeModelResponse_ChatCompletions,
  rewriteFreeModelResponse_Messages,
  rewriteFreeModelResponse_Responses,
} from './rewriteModelResponse';

const publicModelId = 'kilo/preview-model';
const upstreamInternalId = 'partner/secret-checkpoint-rc1';

async function responseText(response: Response) {
  return await response.text();
}

function sseResponse(events: string[]) {
  return new Response(events.join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('experiment response model rewriting', () => {
  it('rewrites chat completion JSON model ids to the requested public id', async () => {
    const upstreamResponse = new Response(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: upstreamInternalId,
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { headers: { 'content-type': 'application/json' } }
    );

    const rewritten = await rewriteFreeModelResponse_ChatCompletions(
      upstreamResponse,
      publicModelId
    );

    const text = await responseText(rewritten);
    expect(text).toContain(publicModelId);
    expect(text).not.toContain(upstreamInternalId);
    expect(JSON.parse(text).model).toBe(publicModelId);
  });

  it('rewrites chat completion SSE model ids to the requested public id', async () => {
    const upstreamResponse = sseResponse([
      `data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        model: upstreamInternalId,
        choices: [{ index: 0, delta: { content: 'hello' } }],
      })}\n\n`,
      'data: [DONE]\n\n',
    ]);

    const rewritten = await rewriteFreeModelResponse_ChatCompletions(
      upstreamResponse,
      publicModelId
    );

    const text = await responseText(rewritten);
    expect(text).toContain(publicModelId);
    expect(text).not.toContain(upstreamInternalId);
    expect(text).toContain('data: [DONE]');
  });

  it('rewrites messages JSON model ids to the requested public id', async () => {
    const upstreamResponse = new Response(
      JSON.stringify({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        model: upstreamInternalId,
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { 'content-type': 'application/json' } }
    );

    const rewritten = await rewriteFreeModelResponse_Messages(upstreamResponse, publicModelId);

    const text = await responseText(rewritten);
    expect(text).toContain(publicModelId);
    expect(text).not.toContain(upstreamInternalId);
    expect(JSON.parse(text).model).toBe(publicModelId);
  });

  it('rewrites messages SSE model ids to the requested public id', async () => {
    const upstreamResponse = sseResponse([
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg-test',
          type: 'message',
          role: 'assistant',
          model: upstreamInternalId,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      })}\n\n`,
    ]);

    const rewritten = await rewriteFreeModelResponse_Messages(upstreamResponse, publicModelId);

    const text = await responseText(rewritten);
    expect(text).toContain(publicModelId);
    expect(text).not.toContain(upstreamInternalId);
    expect(text).toContain('event: message_start');
  });

  it('rewrites responses JSON model ids to the requested public id', async () => {
    const upstreamResponse = new Response(
      JSON.stringify({
        id: 'resp-test',
        object: 'response',
        model: upstreamInternalId,
        status: 'completed',
      }),
      { headers: { 'content-type': 'application/json' } }
    );

    const rewritten = await rewriteFreeModelResponse_Responses(upstreamResponse, publicModelId);

    const text = await responseText(rewritten);
    expect(text).toContain(publicModelId);
    expect(text).not.toContain(upstreamInternalId);
    expect(JSON.parse(text).model).toBe(publicModelId);
  });

  it('rewrites responses SSE model ids to the requested public id', async () => {
    const upstreamResponse = sseResponse([
      `event: response.created\ndata: ${JSON.stringify({
        type: 'response.created',
        response: {
          id: 'resp-test',
          object: 'response',
          model: upstreamInternalId,
          status: 'in_progress',
        },
      })}\n\n`,
      'data: [DONE]\n\n',
    ]);

    const rewritten = await rewriteFreeModelResponse_Responses(upstreamResponse, publicModelId);

    const text = await responseText(rewritten);
    expect(text).toContain(publicModelId);
    expect(text).not.toContain(upstreamInternalId);
    expect(text).toContain('data: [DONE]');
  });
});
