#!/usr/bin/env node
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';

const help = `Generate MCP Gateway key material.

Usage:
  pnpm --filter cloudflare-mcp-gateway keys:generate [options]

Options:
  --format <json|env>       Output format. Default: json.
  --target <bundle|app|worker>
                            Which env payload to emit. Default: bundle.
  --issuer <url>            OAuth issuer for the generated JWT keyset.
                            Default: https://app.kilo.ai.
  --bits <number>           RSA modulus size. Default: 3072.
  --help                    Show this help.

Examples:
  pnpm --filter cloudflare-mcp-gateway keys:generate
  pnpm --filter cloudflare-mcp-gateway keys:generate -- --format env --target app > /tmp/mcp-app.env
  pnpm --filter cloudflare-mcp-gateway keys:generate -- --format env --target worker --issuer http://localhost:3000 > /tmp/mcp-worker.env
`;

function parseArgs(args) {
  const options = {
    format: 'json',
    target: 'bundle',
    issuer: 'https://app.kilo.ai',
    bits: 3072,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      continue;
    }
    if (argument === '--help') {
      options.help = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${argument}`);
    }
    if (argument === '--format') {
      options.format = value;
    } else if (argument === '--target') {
      options.target = value;
    } else if (argument === '--issuer') {
      options.issuer = value;
    } else if (argument === '--bits') {
      options.bits = Number(value);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
    index += 1;
  }

  if (!['json', 'env'].includes(options.format)) {
    throw new Error(`Unsupported format: ${options.format}`);
  }
  if (!['bundle', 'app', 'worker'].includes(options.target)) {
    throw new Error(`Unsupported target: ${options.target}`);
  }
  let issuer;
  try {
    issuer = new URL(options.issuer);
  } catch {
    throw new Error('Issuer must be a valid URL');
  }
  if (issuer.protocol !== 'https:' && issuer.protocol !== 'http:') {
    throw new Error('Issuer must use http or https');
  }
  if (!Number.isInteger(options.bits) || options.bits < 2048) {
    throw new Error('RSA bits must be an integer >= 2048');
  }
  return options;
}

function createKeyPair(bits) {
  return generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function envLines(entries) {
  return Object.entries(entries)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join('\n');
}

function createBundle(options) {
  const jwtPair = createKeyPair(options.bits);
  const credentialPair = createKeyPair(options.bits);
  const jwtKeyId = `mcp-gateway-jwt-${randomUUID()}`;
  const credentialKeyId = `mcp-gateway-credential-${randomUUID()}`;
  const publicJwk = createPublicKey(jwtPair.publicKey).export({ format: 'jwk' });
  const jwtPrivateKeyset = {
    issuer: options.issuer,
    activeKeyId: jwtKeyId,
    keys: [
      {
        keyId: jwtKeyId,
        publicJwk,
        privateKeyPem: jwtPair.privateKey,
      },
    ],
  };
  const jwtPublicJwks = {
    keys: [{ ...publicJwk, kid: jwtKeyId }],
  };
  const credentialKeyset = {
    active: {
      keyId: credentialKeyId,
      publicKeyPem: credentialPair.publicKey,
    },
    decrypt: [
      {
        keyId: credentialKeyId,
        privateKeyPem: credentialPair.privateKey,
      },
    ],
  };
  const rateLimitSecret = randomBytes(32).toString('base64url');
  return {
    issuer: options.issuer,
    appEnv: {
      MCP_GATEWAY_JWT_PRIVATE_KEYSET_JSON: JSON.stringify(jwtPrivateKeyset),
      MCP_GATEWAY_CREDENTIAL_KEYSET_JSON: JSON.stringify(credentialKeyset),
      MCP_GATEWAY_RATE_LIMIT_SECRET: rateLimitSecret,
    },
    workerEnv: {
      MCP_GATEWAY_JWT_PUBLIC_KEYSET_JSON: JSON.stringify(jwtPublicJwks),
      MCP_GATEWAY_CREDENTIAL_KEYSET_JSON: JSON.stringify(credentialKeyset),
      MCP_GATEWAY_RATE_LIMIT_SECRET: rateLimitSecret,
      MCP_GATEWAY_JWT_ISSUER: options.issuer,
    },
  };
}

function selectPayload(bundle, target) {
  if (target === 'app') return bundle.appEnv;
  if (target === 'worker') return bundle.workerEnv;
  return bundle;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help);
    return;
  }
  const bundle = createBundle(options);
  const payload = selectPayload(bundle, options.target);
  if (options.format === 'env') {
    if (options.target === 'bundle') {
      process.stdout.write(
        `# App environment values\n${envLines(bundle.appEnv)}\n\n# Worker environment values\n${envLines(bundle.workerEnv)}\n`
      );
      return;
    }
    process.stdout.write(`${envLines(payload)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  if (error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write('Failed to generate MCP gateway keys\n');
  }
  process.exitCode = 1;
}
