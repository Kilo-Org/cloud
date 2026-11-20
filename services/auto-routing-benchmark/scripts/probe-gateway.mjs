// Fake gateway for capturing the CLI's own requests (scripts/capture-probe-templates.ts).
// It serves the public model catalog, answers the first provider request with one bash tool
// call, and answers the follow-up with a short final text, logging every request it sees.
// Nothing here talks to a paid provider.

import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8787);
const log = process.env.LOG ?? '/tmp/probe-capture/gateway.jsonl';
// The CLI resolves a model's prompt family, variants and reasoning from the catalog it
// fetches, so the capture serves the same public catalog the CLI sees in production
// (scripts/capture-probe-templates.ts writes it here once per run).
const catalogFile = process.env.CATALOG_FILE ?? '/tmp/probe-capture/catalog.json';

const COMMAND = "printf 'probe capture line one\\nprobe capture line two\\n'";
const DESCRIPTION = 'Print two lines';
const FINAL_TEXT = 'Captured both lines.';

function catalog() {
  return JSON.parse(readFileSync(catalogFile, 'utf8'));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function logRequest(req, body, status) {
  appendFileSync(
    log,
    `${JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, headers, status, body })}\n`
  );
}

// Dynamic header values are replaced so no session or machine id reaches the fixture.
const DYNAMIC_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-kilocode-organizationid',
  'x-session-id',
  'x-session-affinity',
  'x-kilocode-taskid',
  'x-kilocode-machineid',
  'host',
  'connection',
  'content-length',
  'accept-encoding',
]);

function scrubbed(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      DYNAMIC_HEADERS.has(name)
        ? ''
        : Array.isArray(value)
          ? value.join(', ')
          : String(value ?? ''),
    ])
  );
}

let headers = {};

function hasToolResult(body) {
  if (Array.isArray(body?.messages)) {
    return body.messages.some(
      m =>
        m.role === 'tool' ||
        (Array.isArray(m.content) && m.content.some(part => part?.type === 'tool_result'))
    );
  }
  if (Array.isArray(body?.input)) {
    return body.input.some(item => item.type === 'function_call_output');
  }
  return false;
}

function chatStream(res) {
  const chunk = (delta, finish = null) => ({
    id: 'chatcmpl-capture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'capture',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
  send(chunk({ role: 'assistant', content: '' }));
  send(
    chunk({
      tool_calls: [
        {
          index: 0,
          id: 'call_capture_1',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: COMMAND, description: DESCRIPTION }),
          },
        },
      ],
    })
  );
  send(chunk({}, 'tool_calls'));
  send({
    ...chunk({}),
    choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

function chatText(res) {
  const chunk = (delta, finish = null) => ({
    id: 'chatcmpl-capture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'capture',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
  send(chunk({ role: 'assistant', content: '' }));
  send(chunk({ content: FINAL_TEXT }));
  send(chunk({}, 'stop'));
  send({
    ...chunk({}),
    choices: [],
    usage: { prompt_tokens: 140, completion_tokens: 4, total_tokens: 144 },
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

function anthropicEvent(res, type, payload) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function anthropicStart(res) {
  anthropicEvent(res, 'message_start', {
    message: {
      id: 'msg_capture',
      type: 'message',
      role: 'assistant',
      model: 'capture',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 1 },
    },
  });
}

function anthropicCall(res) {
  anthropicStart(res);
  anthropicEvent(res, 'content_block_start', {
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_capture_1', name: 'bash', input: {} },
  });
  anthropicEvent(res, 'content_block_delta', {
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: JSON.stringify({ command: COMMAND, description: DESCRIPTION }),
    },
  });
  anthropicEvent(res, 'content_block_stop', { index: 0 });
  anthropicEvent(res, 'message_delta', {
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 8 },
  });
  anthropicEvent(res, 'message_stop', {});
  res.end();
}

function anthropicText(res) {
  anthropicStart(res);
  anthropicEvent(res, 'content_block_start', {
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  anthropicEvent(res, 'content_block_delta', {
    index: 0,
    delta: { type: 'text_delta', text: FINAL_TEXT },
  });
  anthropicEvent(res, 'content_block_stop', { index: 0 });
  anthropicEvent(res, 'message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 4 },
  });
  anthropicEvent(res, 'message_stop', {});
  res.end();
}

function responsesEvent(res, type, payload) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify({ type, sequence_number: 1, ...payload })}\n\n`);
}

function responsesCall(res) {
  const args = JSON.stringify({ command: COMMAND, description: DESCRIPTION });
  responsesEvent(res, 'response.created', {
    response: { id: 'resp_capture', created_at: 1, model: 'capture' },
  });
  responsesEvent(res, 'response.output_item.added', {
    output_index: 0,
    item: {
      type: 'function_call',
      id: 'fc_capture_1',
      call_id: 'call_capture_1',
      name: 'bash',
      arguments: '',
    },
  });
  responsesEvent(res, 'response.function_call_arguments.delta', {
    item_id: 'fc_capture_1',
    output_index: 0,
    delta: args,
  });
  responsesEvent(res, 'response.function_call_arguments.done', {
    item_id: 'fc_capture_1',
    output_index: 0,
    arguments: args,
  });
  responsesEvent(res, 'response.output_item.done', {
    output_index: 0,
    item: {
      type: 'function_call',
      id: 'fc_capture_1',
      call_id: 'call_capture_1',
      name: 'bash',
      arguments: args,
      status: 'completed',
    },
  });
  responsesEvent(res, 'response.completed', {
    response: {
      id: 'resp_capture',
      object: 'response',
      created_at: 1,
      model: 'capture',
      status: 'completed',
      output: [],
      usage: { input_tokens: 100, output_tokens: 8, total_tokens: 108 },
    },
  });
  res.end();
}

function responsesText(res) {
  responsesEvent(res, 'response.created', {
    response: { id: 'resp_capture', created_at: 1, model: 'capture' },
  });
  responsesEvent(res, 'response.output_item.added', {
    output_index: 0,
    item: { type: 'message', id: 'msg_capture' },
  });
  responsesEvent(res, 'response.output_text.delta', {
    item_id: 'msg_capture',
    output_index: 0,
    delta: FINAL_TEXT,
  });
  responsesEvent(res, 'response.output_item.done', {
    output_index: 0,
    item: {
      type: 'message',
      id: 'msg_capture',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: FINAL_TEXT }],
    },
  });
  responsesEvent(res, 'response.completed', {
    response: {
      id: 'resp_capture',
      object: 'response',
      created_at: 1,
      model: 'capture',
      status: 'completed',
      output: [],
      usage: { input_tokens: 140, output_tokens: 4, total_tokens: 144 },
    },
  });
  res.end();
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', part => chunks.push(part));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path.endsWith('/models')) {
      headers = scrubbed(req.headers);
      logRequest(req, null, 200);
      sendJson(res, 200, catalog());
      return;
    }
    if (path.endsWith('/responses') && req.method === 'POST') {
      headers = scrubbed(req.headers);
      logRequest(req, body, 200);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (hasToolResult(body)) responsesText(res);
      else responsesCall(res);
      return;
    }
    if (path.endsWith('/messages') && req.method === 'POST') {
      headers = scrubbed(req.headers);
      logRequest(req, body, 200);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (hasToolResult(body)) anthropicText(res);
      else anthropicCall(res);
      return;
    }
    if (path.endsWith('/chat/completions') && req.method === 'POST') {
      headers = scrubbed(req.headers);
      logRequest(req, body, 200);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (hasToolResult(body)) chatText(res);
      else chatStream(res);
      return;
    }
    logRequest(req, body, 404);
    sendJson(res, 404, { error: { message: 'not found' } });
  });
}).listen(port, '127.0.0.1', () => console.log(`probe capture gateway on ${port}`));
