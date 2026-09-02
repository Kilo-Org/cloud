import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from './types';
import type { ToolCardShell } from './ToolCardShell';

jest.mock('react-markdown', () =>
  process.getBuiltinModule('module').createRequire(__filename)('react-markdown')
);
jest.mock('remark-gfm', () =>
  process.getBuiltinModule('module').createRequire(__filename)('remark-gfm')
);

import { BashToolCard } from './BashToolCard';
import { BackgroundProcessToolCard } from './BackgroundProcessToolCard';
import { GenericToolCard } from './GenericToolCard';
import { ToolCodeBlock } from './ToolOutput';

Object.assign(globalThis, { React });

function completedTool(
  tool: string,
  input: Record<string, unknown>,
  output: string,
  metadata: Record<string, unknown> = {}
): ToolPart {
  return {
    id: 'part-1',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'tool',
    callID: 'call-1',
    tool,
    state: {
      status: 'completed',
      input,
      output,
      title: tool,
      metadata,
      time: { start: 0, end: 2000 },
    },
  };
}

function expanded(card: React.ReactElement<React.ComponentProps<typeof ToolCardShell>>): string {
  return renderToStaticMarkup(React.cloneElement(card, { defaultExpanded: true }));
}

function genericJsonOutput(output: string) {
  const card = GenericToolCard({ toolPart: completedTool('lookup', {}, output) });
  const outputBlock = React.Children.toArray(card.props.children).find(
    (child): child is React.ReactElement<React.ComponentProps<typeof ToolCodeBlock>> =>
      React.isValidElement<React.ComponentProps<typeof ToolCodeBlock>>(child) &&
      child.type === ToolCodeBlock &&
      child.props.label === 'Output'
  );
  if (!outputBlock) throw new Error('Expected a copyable JSON output block');
  return { html: expanded(card), content: outputBlock.props.content };
}

describe('tool output disclosures', () => {
  it.each(['pending', 'running', 'completed', 'error'] as const)(
    'keeps %s cards collapsed with an enabled independent trigger',
    status => {
      for (const Component of [BashToolCard, BackgroundProcessToolCard, GenericToolCard]) {
        const input = { command: 'pwd', action: 'start', description: 'Inspect workspace' };
        const part = completedTool('test', input, 'private output');
        if (status === 'pending') part.state = { status, input, raw: '' };
        if (status === 'running') part.state = { status, input, time: { start: 1 } };
        if (status === 'error') {
          part.state = { status, input, error: 'private error', time: { start: 1, end: 2 } };
        }
        const html = renderToStaticMarkup(React.createElement(Component, { toolPart: part }));

        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain('disabled=');
        expect(html).not.toContain('Copy command');
        expect(html).not.toContain('private output');
        expect(html).not.toContain('private error');
        expect(html.match(/<button\b/g)).toHaveLength(1);
      }
    }
  );
});

describe('BashToolCard', () => {
  it('leads with the description rather than the command', () => {
    const part = completedTool(
      'bash',
      { command: 'pnpm test --filter unit', description: 'Run focused tests' },
      'Tests passed'
    );
    const html = renderToStaticMarkup(React.createElement(BashToolCard, { toolPart: part }));

    expect(html).toContain('Shell');
    expect(html).toContain('Run focused tests');
    expect(html).not.toContain('pnpm test');
  });

  it('shows the description only in the header and omits visible command/output labels', () => {
    const part = completedTool(
      'bash',
      { command: 'pnpm test', description: 'Run focused tests' },
      'Tests passed'
    );
    const html = expanded(BashToolCard({ toolPart: part }));

    expect(html.match(/Run focused tests/g)).toHaveLength(1);
    expect(html).not.toContain('>Command<');
    expect(html).not.toContain('>Output<');
    expect(html).toContain('aria-label="Command"');
    expect(html).toContain('aria-label="Output"');
    expect(html.match(/lucide-terminal/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Copy command"');
    expect(html).toContain('aria-label="Copy output"');
  });

  it('always shows the full command and output as separately copyable sections', () => {
    const part = completedTool(
      'bash',
      { command: 'pwd', workdir: '/workspace/project' },
      '/result'
    );
    const html = expanded(BashToolCard({ toolPart: part }));
    const trigger = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/)?.[0];

    expect(html).toContain('<code>pwd</code>');
    expect(html).toContain('<code>/result</code>');
    expect(html).toContain('cwd: /workspace/project');
    expect(html).toContain('aria-label="Copy command"');
    expect(html).toContain('aria-label="Copy output"');
    expect(trigger).not.toContain('Copy command');
    expect(trigger).not.toContain('Copy output');
    expect(html).not.toContain('Open in editor');
  });

  it.each([
    '/workspace/org/user/sessions/agent-one/README',
    '/workspace/7c21ccc1-e50c-4b65-a2a5-d89c70310f4b/sessions/workspace_36c067fe-a515-4fcf-876d-40ec25a90171/README',
  ])('shortens workspace path %s only in the fallback preview', path => {
    const command = `cat ${path}\npwd`;
    const part = completedTool('bash', { command }, 'done');
    const collapsed = renderToStaticMarkup(React.createElement(BashToolCard, { toolPart: part }));
    const html = expanded(BashToolCard({ toolPart: part }));

    expect(collapsed).toContain('cat ./README');
    expect(collapsed).not.toContain('/workspace/');
    expect(html).toContain(`<code>${command}</code>`);
    expect(html).toContain('aria-label="Copy command"');
  });

  it('marks running metadata output busy while leaving the command idle', () => {
    const part = completedTool('bash', {}, '');
    part.state = {
      status: 'running',
      input: { command: 'pnpm test' },
      metadata: { output: '\u001b[32m10%\r100%\r\nPassed\u001b[0m\n' },
      time: { start: 1 },
    };
    const html = expanded(BashToolCard({ toolPart: part }));

    expect(html).toContain('<code>100%\nPassed\n</code>');
    expect(html).not.toContain('10%');
    expect(html).not.toContain('Waiting for output');
    expect(html.match(/<pre\b[^>]*aria-label="Output"[^>]*>/)?.[0]).toContain('aria-busy="true"');
    expect(html.match(/<pre\b[^>]*aria-label="Command"[^>]*>/)?.[0]).not.toContain('aria-busy=');
  });

  it.each(['final output', ''])('uses the final output instead of stale metadata: %j', output => {
    const part = completedTool('bash', { command: 'pwd' }, output, { output: 'stale snapshot' });
    const html = expanded(BashToolCard({ toolPart: part }));

    expect(html).not.toContain('stale snapshot');
    expect(html).toContain(output || 'Command completed with no output.');
    expect(html).not.toContain('aria-busy="true"');
  });

  it('uses known metadata fallbacks and tolerates incomplete or malformed input fields', () => {
    const part = completedTool(
      'bash',
      { command: { invalid: true }, description: 42, workdir: ['not a directory'] },
      'Finished',
      { command: 'pwd', description: 'Inspect current directory' }
    );
    const html = expanded(BashToolCard({ toolPart: part }));

    expect(html).toContain('Inspect current directory');
    expect(html).toContain('<code>pwd</code>');
    expect(html).toContain('<code>Finished</code>');
    expect(html).not.toContain('[object Object]');
    expect(html).not.toContain('cwd:');
    expect(html).not.toContain('Waiting');
  });

  it.each([
    [{ status: 'pending', input: {}, raw: '' }, 'Waiting to execute...'],
    [
      {
        status: 'running',
        input: { command: 'pwd' },
        metadata: { output: 42 },
        time: { start: 1 },
      },
      'Waiting for output...',
    ],
  ] satisfies [ToolPart['state'], string][])(
    'shows an explicit waiting state when no output is available',
    (state, expected) => {
      const part = { ...completedTool('bash', {}, ''), state };
      const html = expanded(BashToolCard({ toolPart: part }));

      expect(html).toContain(expected);
      expect(html).not.toContain('Copy output');
    }
  );
});

describe('BackgroundProcessToolCard', () => {
  it.each([
    ['start', 'Start background process'],
    ['list', 'List background processes'],
    ['status', 'Check background process'],
    ['logs', 'View background logs'],
    ['stop', 'Stop background process'],
    ['restart', 'Restart background process'],
    ['unknown', 'Background process'],
  ])('uses an action-specific title for %s', (action, title) => {
    const part = completedTool('background_process', { action, id: 'bgp-1' }, '');
    const html = renderToStaticMarkup(
      React.createElement(BackgroundProcessToolCard, { toolPart: part })
    );

    expect(html).toContain(title);
    expect(html).toContain('bgp-1');
    expect(html).toContain('aria-expanded="false"');
  });

  it('renders the upstream text result and preserves unrecognized lines', () => {
    const part = completedTool(
      'background_process',
      {
        action: 'start',
        command: 'pnpm dev',
        description: 'Web server',
        workdir: '/input-cwd',
        ready: { port: 3000, pattern: 'ready', timeout: 5000 },
      },
      'id: bgp-1\nstatus: running\npid: 42\ncwd: /actual-cwd\ncommand: pnpm dev\nlast_output: \u001b[32mReady\u001b[0m\nlifetime: session',
      { processID: 'stale-id', status: 'stopped' }
    );
    const html = expanded(BackgroundProcessToolCard({ toolPart: part }));

    for (const value of [
      'Web server',
      'bgp-1',
      'running',
      '42',
      '/actual-cwd',
      '3000',
      '5000 ms',
    ]) {
      expect(html).toContain(value);
    }
    expect(html).toContain('Readiness pattern');
    expect(html).toContain('<code>Ready</code>');
    expect(html).toContain('<code>lifetime: session</code>');
    expect(html).not.toContain('/input-cwd');
    expect(html).not.toContain('stale-id');
    expect(html).not.toContain('animate-spin');
    expect(html).not.toContain('Waiting for process result');
    expect(html.match(/aria-label="Copy [^"]+"/g)).toEqual([
      'aria-label="Copy command"',
      'aria-label="Copy last output"',
      'aria-label="Copy output"',
    ]);
    expect(html.match(/<button\b/g)).toHaveLength(4);
  });

  it('narrows structured JSON fields while preserving extra data and output', () => {
    const part = completedTool(
      'background_process',
      { action: 'status', id: 'input-id' },
      JSON.stringify({
        id: 'bgp-json',
        status: 'ready',
        pid: 123,
        cwd: '/project',
        output: 'first\nsecond',
        extra: { keep: true },
      })
    );
    const html = expanded(BackgroundProcessToolCard({ toolPart: part }));

    expect(html).toContain('bgp-json');
    expect(html).toContain('123');
    expect(html).toContain('/project');
    expect(html).toContain('first\nsecond');
    expect(html).toContain('&quot;keep&quot;: true');
    expect(html).not.toContain('input-id');
  });

  it('preserves command and structured log whitespace for display and copying', () => {
    const command = '\n  pnpm dev\n';
    const part = completedTool(
      'background_process',
      { action: 'start', command },
      JSON.stringify({ id: 'bgp-1', output: '  ready\n' })
    );
    const html = expanded(BackgroundProcessToolCard({ toolPart: part }));

    expect(html).toContain(`<code>${command}</code>`);
    expect(html).toContain('<code>  ready\n</code>');
  });

  it('retains malformed JSON fields as output instead of coercing them into process metadata', () => {
    const part = completedTool(
      'background_process',
      { action: 'status', id: 'fallback-id', ready: { port: { invalid: true } } },
      '{"id":{"nested":"preserved"},"pid":[7]}'
    );
    const html = expanded(BackgroundProcessToolCard({ toolPart: part }));

    expect(html).toContain('fallback-id');
    expect(html).toContain('preserved');
    expect(html).not.toContain('[object Object]');
    expect(html).not.toContain('Readiness port');
    expect(html).not.toContain('>PID</dt>');
  });

  it.each(['logs', 'list'])(
    'keeps %s output raw instead of parsing log lines as fields',
    action => {
      const part = completedTool(
        'background_process',
        { action, id: 'input-id' },
        'status: internal log message\npid: not process metadata\nmore output',
        { processID: 'bgp-meta', status: 'running' }
      );
      const html = expanded(BackgroundProcessToolCard({ toolPart: part }));

      expect(html).toContain('bgp-meta');
      expect(html).toContain(
        '<code>status: internal log message\npid: not process metadata\nmore output</code>'
      );
      expect(html).not.toContain('>PID</dt>');
    }
  );

  it.each(['[{"id":"array-id"}]', 'null', 'Unrecognized result'])('keeps raw result %j', output => {
    const part = completedTool('background_process', { action: 'status' }, output);
    const html = expanded(BackgroundProcessToolCard({ toolPart: part }));
    const code = renderToStaticMarkup(React.createElement('code', null, output));

    expect(html).toContain(code);
    expect(html).not.toContain('>Process id</dt>');
  });

  it('shows the available list count without treating a process as an active tool call', () => {
    const part = completedTool('background_process', { action: 'list' }, 'No processes.', {
      count: 0,
    });
    const html = renderToStaticMarkup(
      React.createElement(BackgroundProcessToolCard, { toolPart: part })
    );

    expect(html).toContain('0 processes');
    expect(html).not.toContain('animate-spin');
  });
});

describe('GenericToolCard', () => {
  it.each([
    ['app-builder-images_transfer_image', 'Publish Image'],
    ['app-builder-images_get_image', 'Analyze Image'],
    ['unrecognized_tool', 'unrecognized_tool'],
  ])('preserves the friendly display name for %s', (tool, title) => {
    const part = completedTool(tool, {}, '');
    const html = renderToStaticMarkup(React.createElement(GenericToolCard, { toolPart: part }));

    expect(html).toContain(title);
  });

  it('uses the MCP envelope for naming and only its arguments for the input section', () => {
    const part = completedTool(
      'mcp',
      {
        server_name: 'app-builder-images',
        tool_name: 'transfer_image',
        arguments: { url: 'https://example.com/image.png', quality: 'high' },
      },
      'Published'
    );
    const html = expanded(GenericToolCard({ toolPart: part }));

    expect(html).toContain('Publish Image');
    expect(html).toContain('https://example.com/image.png · quality=high');
    expect(html).toContain('aria-label="Copy arguments"');
    expect(html).not.toContain('server_name');
    expect(html).not.toContain('tool_name');
  });

  it('summarizes a meaningful label and only one other scalar argument', () => {
    const part = completedTool(
      'lookup',
      {
        description: 'Find matching records',
        query: 'other label',
        nested: {},
        count: 0,
        verbose: false,
      },
      ''
    );
    const html = renderToStaticMarkup(React.createElement(GenericToolCard, { toolPart: part }));

    expect(html).toContain('Find matching records · count=0');
    expect(html).not.toContain('other label');
    expect(html).not.toContain('verbose');
    expect(html).not.toContain('[object Object]');
  });

  it.each([
    ['{"ok":true}', '{\n  &quot;ok&quot;: true\n}'],
    ['[1,2]', '[\n  1,\n  2\n]'],
    ['null', 'null'],
    ['false', 'false'],
    ['"hello"', '&quot;hello&quot;'],
  ])('formats valid JSON output %s in a copyable code block', (output, expected) => {
    const part = completedTool('lookup', {}, output);
    const html = expanded(GenericToolCard({ toolPart: part }));

    expect(html).toContain(`<code>${expected}</code>`);
    expect(html).toContain('aria-label="Copy output"');
    expect(html).toContain('2.0s');
  });

  it.each([
    '9007199254740993',
    '-9007199254740993',
    '0.12345678901234567890123456789',
    '-0.12345678901234567890123456789',
    '1.0000000000000001e+30',
    '-1.0000000000000001e+30',
    '1e-400',
    '-1e-400',
    '1e400',
    '-1e400',
    '-0',
    '-0.0',
    '-0e+3',
    '1.0',
    '1e3',
    '1E+3',
    '0.0000001',
  ])('preserves raw copyable JSON for numeric literal %s', literal => {
    const output = `{"id":${literal}}`;
    const { html, content } = genericJsonOutput(output);

    expect(content).toBe(output);
    expect(html).toContain(renderToStaticMarkup(React.createElement('code', null, output)));
    expect(html).toContain('aria-label="Copy output"');
  });

  it('retains the entire original payload when a nested number cannot round-trip', () => {
    const output = ' \n[{"safe":1},[{"precise":9007199254740993}]]\n ';
    const { html, content } = genericJsonOutput(output);

    expect(content).toBe(output);
    expect(html).toContain(renderToStaticMarkup(React.createElement('code', null, output)));
  });

  it.each(['0', '9007199254740991', '-9007199254740991', '0.125', '-0.125', '1e-7', '1e+21'])(
    'still formats JSON with an unchanged numeric literal %s',
    literal => {
      const { html, content } = genericJsonOutput(`{"value":${literal}}`);
      const expected = `{\n  "value": ${literal}\n}`;

      expect(content).toBe(expected);
      expect(html).toContain(renderToStaticMarkup(React.createElement('code', null, expected)));
    }
  );

  it.each([
    '9007199254740993',
    '-9007199254740993 1e400 -0 0.12345678901234567890123456789',
    '{"id":9007199254740993,"value":1e-400}',
    String.raw`escaped \"9007199254740993\" and \\ -1e400`,
    String.raw`trailing backslash \\`,
  ])('does not mistake digits or escaped quotes inside JSON strings for numbers: %s', value => {
    const data = { '9007199254740993': value, count: 1 };
    const output = JSON.stringify(data);
    const expected = JSON.stringify(data, null, 2);
    const { html, content } = genericJsonOutput(output);

    expect(content).toBe(expected);
    expect(html).toContain(renderToStaticMarkup(React.createElement('code', null, expected)));
  });

  it.each(['NaN', 'Infinity', '-Infinity'])(
    'preserves invalid JSON numeric spelling %s as text rather than converting it to null',
    literal => {
      const output = `{"value":${literal}}`;
      const part = completedTool('lookup', {}, output);
      const html = expanded(GenericToolCard({ toolPart: part }));

      expect(html).toContain(renderToStaticMarkup(React.createElement('p', null, output)));
      expect(html).not.toContain('null');
    }
  );

  it('renders non-JSON output as Markdown with safe links and copyable code', () => {
    const part = completedTool(
      'lookup',
      {},
      '**Result**\nnext line\n\n[Docs](https://example.com/docs) [Local](/workspace/file)\n\n```txt\nresult code\n```'
    );
    const html = expanded(GenericToolCard({ toolPart: part }));

    expect(html).toContain('<strong>Result</strong>\nnext line');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).not.toContain('href="/workspace');
    expect(html).toContain('Local');
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('<code>result code</code>');
  });

  it('preserves safe attachments and displays unsafe attachment names without links', () => {
    const part = completedTool('lookup', {}, '');
    if (part.state.status !== 'completed') throw new Error('Expected completed fixture');
    part.state.attachments = [
      {
        id: 'safe-file',
        sessionID: part.sessionID,
        messageID: part.messageID,
        type: 'file',
        mime: 'text/plain',
        filename: 'Safe file',
        url: 'https://example.com/file.txt',
      },
      {
        id: 'unsafe-file',
        sessionID: part.sessionID,
        messageID: part.messageID,
        type: 'file',
        mime: 'text/plain',
        filename: 'Local file',
        url: 'file:///workspace/file.txt',
      },
    ];
    const html = expanded(GenericToolCard({ toolPart: part }));

    expect(html).toContain('href="https://example.com/file.txt"');
    expect(html).toContain('Safe file');
    expect(html).toContain('Local file');
    expect(html).not.toContain('href="file:');
    expect(html).not.toContain('No output.');
  });

  it.each([null, ['invalid'], 'invalid'])('tolerates malformed MCP arguments %j', args => {
    const part = completedTool(
      'mcp',
      { server_name: 'custom', tool_name: 'lookup', arguments: args },
      'Still completed'
    );
    const html = expanded(GenericToolCard({ toolPart: part }));

    expect(html).toContain('custom/lookup');
    expect(html).toContain('Still completed');
    expect(html).not.toContain('Copy arguments');
    expect(html).not.toContain('Waiting');
  });
});
