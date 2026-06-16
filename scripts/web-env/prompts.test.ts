import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createTerminalPrompts, normalizeMultilineInput } from './prompts.js';

void test('coalesces pasted CRLF multiline input and never echoes its value', async () => {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode(enabled: boolean): void;
  };
  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  const rawModes: boolean[] = [];
  let visibleOutput = '';
  input.isTTY = true;
  input.setRawMode = enabled => {
    rawModes.push(enabled);
  };
  output.isTTY = true;
  output.setEncoding('utf8');
  output.on('data', chunk => {
    visibleOutput += String(chunk);
  });

  const result = createTerminalPrompts(input, output).askSecret('Secret', 'multiline');
  input.write('line-one\r');
  await new Promise<void>(resolve => setImmediate(resolve));
  input.write('\nline-two\r');
  await new Promise<void>(resolve => setImmediate(resolve));
  input.write('\n::end\r');
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  input.write('\n');

  assert.equal(await result, 'line-one\nline-two');
  assert.equal(input.readableLength, 0);
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(visibleOutput.includes('line-one'), false);
  assert.equal(visibleOutput.includes('line-two'), false);
});

void test('normalizes the terminal sentinel newline consistently for both providers', () => {
  assert.equal(normalizeMultilineInput('{"key":"value"}\n'), '{"key":"value"}');
  assert.equal(
    normalizeMultilineInput('-----BEGIN KEY-----\nvalue\n-----END KEY-----\n'),
    '-----BEGIN KEY-----\nvalue\n-----END KEY-----'
  );
  assert.equal(normalizeMultilineInput('already-normalized'), 'already-normalized');
});
