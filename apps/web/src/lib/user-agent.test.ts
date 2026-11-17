import { getUserAgentName } from './user-agent';

describe('getUserAgentName', () => {
  it.each([
    null,
    undefined,
    '',
    ' \t\n ',
    '()',
    '///',
    '123/4',
    '<oversized>',
    'https://example.test/',
  ])('returns Unknown for missing or unusable input %s', input => {
    expect(getUserAgentName(input)).toBe('Unknown');
  });

  it.each([
    ['Kilo-Code/1.2.3 ai-sdk/provider-utils/1 runtime/bun/1', 'Kilo Code'],
    ['kilocode/5.0', 'Kilo Code'],
    ['kilo/latest/1.2.3/cli', 'Kilo CLI'],
    ['kilo2/v2/1.2.3/cli', 'Kilo CLI'],
    ['Kilo CLI 1.2.3', 'Kilo CLI'],
    ['kilo-cli/1.2.3', 'Kilo CLI'],
    ['kilo/1.2.3', 'Kilo'],
    ['opencode/latest/1.2.3/cli', 'OpenCode CLI'],
    ['opencode/latest/1.2.3/desktop', 'OpenCode Desktop'],
    ['opencode/1.2.3', 'OpenCode'],
    ['claude-cli/1.2.3', 'Claude Code'],
    ['Codex Desktop/1.2.3', 'Codex Desktop'],
    ['codex-tui/1.2.3', 'Codex CLI'],
    ['codex_cli_rs/1.2.3', 'Codex CLI'],
    ['codex_exec/1.2.3', 'Codex CLI'],
    ['codex_vscode/1.2.3', 'Codex for VS Code'],
    ['pi/1.2.3', 'Pi'],
    ['pi.dev/1.2.3', 'Pi'],
    ['omp/1.2.3', 'Oh My Pi'],
    ['kimi-code-cli/1.2.3', 'Kimi Code CLI'],
    ['KimiCLI/1.2.3', 'Kimi Code CLI'],
    ['Charm-Crush/1.2.3', 'Crush'],
    ['factory-cli/1.2.3', 'Droid CLI'],
    ['GitHubCopilotChat/1.2.3', 'GitHub Copilot Chat'],
    ['QwenCode/1.2.3', 'Qwen Code'],
    ['RooCode/1.2.3', 'Roo Code'],
    ['Cline/1.2.3', 'Cline'],
    ['antigravity/1.2.3', 'Antigravity'],
    ['antigravity/cli', 'Google Antigravity CLI'],
    ['deepseek-harness/1.2.3', 'DeepSeek Harness'],
    ['RikkaHub-Android/1.2.3', 'RikkaHub'],
    ['WorkBuddy/1.2.3', 'WorkBuddy'],
    ['CodeBuddy/1.2.3', 'CodeBuddy'],
    ['Zed/1.2.3', 'Zed'],
    ['CherryStudio/1.2.3', 'Cherry Studio'],
    ['LiteLLM/1.2.3', 'LiteLLM'],
  ])('recognizes app %s as %s', (input, expected) => {
    expect(getUserAgentName(input)).toBe(expected);
  });

  it.each([
    ['OpenAI/Python 1.2', 'OpenAI Python SDK'],
    ['AsyncOpenAI/Python/1.2', 'OpenAI Python SDK'],
    ['OpenAI/JS/1.2', 'OpenAI JavaScript SDK'],
    ['Anthropic/Python/1.2', 'Anthropic Python SDK'],
    ['Anthropic/JS/1.2', 'Anthropic JavaScript SDK'],
    ['ai/1.2.3', 'Vercel AI SDK'],
    ['ai-sdk/provider-utils/1.2.3', 'Vercel AI SDK'],
    ['ai-sdk-openai/1.2.3', 'Vercel AI SDK'],
    ['python-requests/2.0', 'Python Requests'],
    ['Python/3.12 aiohttp/3.9', 'aiohttp'],
    ['Python-urllib/3.12', 'Python urllib'],
    ['python-httpx/0.27', 'HTTPX'],
    ['curl/8.0', 'curl'],
    ['node/22.0', 'Node.js'],
    ['undici/7.0', 'Undici'],
    ['Bun/1.0', 'Bun'],
    ['Deno/2.0', 'Deno'],
    ['okhttp/4.0', 'OkHttp'],
    ['Go-http-client/1.1', 'Go HTTP Client'],
    ['Java-http-client/21', 'Java HTTP Client'],
    ['axios/1.0', 'Axios'],
    ['GuzzleHttp/7.0', 'GuzzleHttp'],
    ['lua-resty-http/0.1', 'lua-resty-http'],
    ['node-fetch/3.0', 'node-fetch'],
    ['Dart/3.0', 'Dart'],
  ])('recognizes SDK or runtime %s as %s', (input, expected) => {
    expect(getUserAgentName(input)).toBe(expected);
  });

  it.each([
    ['Mozilla/5.0 (platform) AppleWebKit/537 Chrome/130 Safari/537 Edg/130', 'Microsoft Edge'],
    ['Mozilla/5.0 Chrome/130 Safari/537 EdgA/130', 'Microsoft Edge'],
    ['Mozilla/5.0 CriOS/130 Safari/537 EdgiOS/130', 'Microsoft Edge'],
    ['Mozilla/5.0 Chrome/130 Safari/537 OPR/110', 'Opera'],
    ['Mozilla/5.0 Chrome/130 Safari/537 SamsungBrowser/25', 'Samsung Internet'],
    ['Mozilla/5.0 Chrome/130 Safari/537 HeadlessChrome/130', 'Headless Chrome'],
    ['Mozilla/5.0 Firefox/130', 'Firefox'],
    ['Mozilla/5.0 FxiOS/130 Safari/537', 'Firefox'],
    ['Mozilla/5.0 Chrome/130 Safari/537', 'Chrome'],
    ['Mozilla/5.0 CriOS/130 Safari/537', 'Chrome'],
    ['Mozilla/5.0 Version/17 Safari/605', 'Safari'],
    ['Mozilla/5.0 Chrome/130 Safari/537 Electron/30', 'Electron'],
    ['Zed/1.0 Chrome/130 Electron/30', 'Zed'],
    ['Kilo-Code/1.0 OpenAI/JS/1 node/22', 'Kilo Code'],
    ['node/22 ai-sdk-openai/1', 'Vercel AI SDK'],
  ])('prefers the specific client in %s', (input, expected) => {
    expect(getUserAgentName(input)).toBe(expected);
  });

  it.each([
    ['kilo-proxy/1.2.3', 'Kilo Proxy'],
    ['opencode-proxy/1.2.3', 'Opencode Proxy'],
    ['kilo-proxy/1.2.3 ai-sdk/2.0', 'Kilo Proxy'],
    ['kilo-code-proxy/1.0', 'Kilo Code Proxy'],
    ['customTool/1.2.3 (Chrome/130; Cline/1.0)', 'Custom Tool'],
    ['customTool/1.2.3 https://example.test/Chrome/130', 'Custom Tool'],
    ['customTool/1.2.3 (comment (Kilo-Code/1) more)', 'Custom Tool'],
    ['qz4-sdk/1.2.3', 'Qz4 SDK'],
    ['n8n/1.2.3', 'n8n'],
    ['custom-ai-api-cli/1.2.3', 'Custom AI API CLI'],
    ['GPT4All/1.2.3', 'GPT4All'],
    ['9router/1.2.3', '9router'],
    ['SomeTool-v1.2.3-beta+build.42', 'Some Tool'],
    ['SomeTool-nightly/1.2.3', 'Some Tool'],
  ])('falls back conservatively for %s', (input, expected) => {
    expect(getUserAgentName(input)).toBe(expected);
  });

  it.each([
    [String.raw`customTool/1.2.3 (escaped \) Cline/1.0)`, 'Custom Tool'],
    [String.raw`customTool/1.2.3 (escaped \( Cline/1.0) Zed/1`, 'Zed'],
    [String.raw`customTool/1.2.3 (escaped \\) Cline/1.0`, 'Cline'],
    [String.raw`customTool/1.2.3 (outer (inner \) Cline/1) still comment)`, 'Custom Tool'],
    [String.raw`customTool/1.2.3 (outer (inner \() Cline/1)`, 'Custom Tool'],
    ['customTool/1.2.3 https://example.test/(info)Cline/1', 'Custom Tool'],
    ['customTool/1.2.3 HTTP://example.test/(info)Cline/1', 'Custom Tool'],
    ['https://example.test/(info)Cline/1', 'Unknown'],
    ['customTool/1.2.3 https://example.test/(unclosed Zed/1', 'Zed'],
    ['customTool/1.2.3(info)https://example.test/(info)Cline/1', 'Custom Tool'],
    ['customTool/1.2.3(info)Cline/1', 'Cline'],
    ['customTool/1.2.3(info)(more)Cline/1', 'Cline'],
  ])('handles comments and URLs without attributing incidental text in %s', (input, expected) => {
    expect(getUserAgentName(input)).toBe(expected);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(getUserAgentName('  kIlO-cOdE/1.2.3  ')).toBe('Kilo Code');
  });

  it('is stable across channels, prereleases and builds', () => {
    for (const version of ['1.2.3', '2.0.0-beta.4+build.12', 'latest/9.1.0', 'v2/3.0.0']) {
      expect(getUserAgentName(`kilo/${version}/cli`)).toBe('Kilo CLI');
      expect(getUserAgentName(`customTool/${version}`)).toBe('Custom Tool');
    }
  });

  it('bounds its output for oversized input', () => {
    expect(getUserAgentName(`${'x'.repeat(5000)}/1.0`)).toHaveLength(80);
  });
});
