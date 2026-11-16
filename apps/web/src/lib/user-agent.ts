// Product names are matched exactly, not as prefixes: e.g. kilo-proxy is not Kilo.
const appNames = new Map<string, string>([
  ['kilo-code', 'Kilo Code'],
  ['kilocode', 'Kilo Code'],
  ['kilo-cli', 'Kilo CLI'],
  ['claude-cli', 'Claude Code'],
  ['codex-tui', 'Codex CLI'],
  ['codex_cli_rs', 'Codex CLI'],
  ['codex_exec', 'Codex CLI'],
  ['codex_vscode', 'Codex for VS Code'],
  ['pi', 'Pi'],
  ['pi.dev', 'Pi'],
  ['omp', 'Oh My Pi'],
  ['kimi-code-cli', 'Kimi Code CLI'],
  ['kimicli', 'Kimi Code CLI'],
  ['charm-crush', 'Crush'],
  ['factory-cli', 'Droid CLI'],
  ['githubcopilotchat', 'GitHub Copilot Chat'],
  ['qwencode', 'Qwen Code'],
  ['roocode', 'Roo Code'],
  ['cline', 'Cline'],
  ['antigravity', 'Antigravity'],
  ['deepseek-harness', 'DeepSeek Harness'],
  ['rikkahub-android', 'RikkaHub'],
  ['workbuddy', 'WorkBuddy'],
  ['codebuddy', 'CodeBuddy'],
  ['zed', 'Zed'],
  ['cherrystudio', 'Cherry Studio'],
  ['litellm', 'LiteLLM'],
]);

const clientNames = new Map<string, string>([
  ['python-requests', 'Python Requests'],
  ['aiohttp', 'aiohttp'],
  ['python-urllib', 'Python urllib'],
  ['python-httpx', 'HTTPX'],
  ['httpx', 'HTTPX'],
  ['curl', 'curl'],
  ['node', 'Node.js'],
  ['undici', 'Undici'],
  ['bun', 'Bun'],
  ['deno', 'Deno'],
  ['okhttp', 'OkHttp'],
  ['go-http-client', 'Go HTTP Client'],
  ['java-http-client', 'Java HTTP Client'],
  ['axios', 'Axios'],
  ['guzzlehttp', 'GuzzleHttp'],
  ['lua-resty-http', 'lua-resty-http'],
  ['node-fetch', 'node-fetch'],
  ['dart', 'Dart'],
]);

const wordNames = new Map<string, string>([
  ['ai', 'AI'],
  ['api', 'API'],
  ['cli', 'CLI'],
  ['gpt', 'GPT'],
  ['http', 'HTTP'],
  ['js', 'JS'],
  ['llm', 'LLM'],
  ['n8n', 'n8n'],
  ['openai', 'OpenAI'],
  ['sdk', 'SDK'],
  ['ui', 'UI'],
]);

type Product = { name: string; path: string[] };

// Comments can contain arbitrary text or URLs; only top-level product tokens identify clients.
function getProducts(userAgent: string): Product[] {
  const input = userAgent.slice(0, 4096);
  const tokens: string[] = [];
  let token = '';
  let depth = 0;
  let escaped = false;
  let inUrl = false;
  const finishToken = () => {
    if (token) tokens.push(token);
    token = '';
  };

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (inUrl) {
      if (!/\s/.test(char)) continue;
      inUrl = false;
    }
    if (depth > 0) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '(') depth++;
      else if (char === ')') depth--;
      continue;
    }
    // Skip the entire URL before interpreting parentheses as comments.
    if ((char === 'h' || char === 'H') && /^https?:\/\//i.test(input.slice(index, index + 8))) {
      token = '';
      inUrl = true;
      continue;
    }
    if (char === '(') {
      finishToken();
      depth = 1;
    } else if (/\s/.test(char)) {
      finishToken();
    } else {
      token += char;
    }
  }
  finishToken();

  return tokens
    .filter(token => /^[a-z0-9][a-z0-9._+-]*(?:\/[^\s]*)?$/i.test(token))
    .map(token => {
      const [name, ...path] = token.split('/');
      return { name, path };
    });
}

function appName(product: Product, next?: Product): string | undefined {
  const name = product.name.toLowerCase();
  const path = product.path.map(part => part.toLowerCase());
  const nextName = next?.name.toLowerCase();

  if (name === 'kilo' || name === 'kilo2') {
    if (path.includes('cli') || nextName === 'cli') return 'Kilo CLI';
    return 'Kilo';
  }
  if (name === 'opencode') {
    if (path.includes('cli') || nextName === 'cli') return 'OpenCode CLI';
    if (path.includes('desktop') || nextName === 'desktop') return 'OpenCode Desktop';
    return 'OpenCode';
  }
  if (name === 'codex') {
    if (path.includes('desktop') || nextName === 'desktop') return 'Codex Desktop';
    if (path.includes('cli') || nextName === 'cli') return 'Codex CLI';
    return 'Codex';
  }
  if (name === 'antigravity' && path.includes('cli')) return 'Google Antigravity CLI';
  return appNames.get(name);
}

function sdkName(product: Product): string | undefined {
  const name = product.name.toLowerCase();
  const language = product.path[0]?.toLowerCase();
  if (name === 'ai' || name === 'ai-sdk' || name === 'ai-sdk-openai') return 'Vercel AI SDK';
  if (name === 'openai' || name === 'asyncopenai' || name === 'anthropic') {
    const provider = name === 'anthropic' ? 'Anthropic' : 'OpenAI';
    if (language === 'python') return `${provider} Python SDK`;
    if (language === 'js') return `${provider} JavaScript SDK`;
  }
  return undefined;
}

function fallbackName(product: Product | undefined): string {
  if (!product || !/[a-z]/i.test(product.name)) return 'Unknown';
  const name = product.name
    .replace(/[-_.]v?\d+(?:[._]\d+)*(?:[-+][a-z0-9.+-]+)?$/i, '')
    .replace(/[-_.](?:latest|stable|beta|alpha|nightly|preview|canary)$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .trim();
  if (!name) return 'Unknown';
  return name
    .split(' ')
    .map(word => wordNames.get(word.toLowerCase()) ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .slice(0, 80);
}

/** Returns a bounded, versionless best-effort name, without inferring from comments or URLs. */
export function getUserAgentName(userAgent: string | null | undefined): string {
  const products = getProducts(userAgent ?? '');
  for (const [index, product] of products.entries()) {
    const name = appName(product, products[index + 1]);
    if (name) return name;
  }

  const names = new Set(products.map(product => product.name.toLowerCase()));
  // Browser variants and Electron include Chrome/Safari compatibility tokens.
  if (names.has('electron')) return 'Electron';
  if (names.has('edg') || names.has('edga') || names.has('edgios')) return 'Microsoft Edge';
  if (names.has('opr')) return 'Opera';
  if (names.has('samsungbrowser')) return 'Samsung Internet';
  if (names.has('fxios') || names.has('firefox')) return 'Firefox';
  if (names.has('headlesschrome')) return 'Headless Chrome';
  if (names.has('chrome') || names.has('crios')) return 'Chrome';
  if (names.has('safari')) return 'Safari';

  const first = products[0];
  // Keep an unrecognized leading app rather than replacing it with its embedded SDK.
  if (
    first &&
    !sdkName(first) &&
    !clientNames.has(first.name.toLowerCase()) &&
    first.name.toLowerCase() !== 'python'
  ) {
    return fallbackName(first);
  }
  for (const product of products) {
    const name = sdkName(product);
    if (name) return name;
  }
  for (const product of products) {
    const name = clientNames.get(product.name.toLowerCase());
    if (name) return name;
  }
  return fallbackName(first);
}
