import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

const REDACTED = '[redacted]';

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactFields(object: JsonObject, fields: readonly string[]): JsonObject {
  const redacted = { ...object };
  for (const field of fields) {
    if (redacted[field] !== undefined && redacted[field] !== null) redacted[field] = REDACTED;
  }
  return redacted;
}

/** Keeps header names, which are useful for debugging, and redacts every value. */
function redactHeaderValues(object: JsonObject, field: string): JsonObject {
  const headers = object[field];
  if (!isJsonObject(headers)) return object;
  return {
    ...object,
    [field]: Object.fromEntries(Object.keys(headers).map(name => [name, REDACTED])),
  };
}

function mapObjectArray(value: unknown, map: (object: JsonObject) => JsonObject): unknown {
  return Array.isArray(value)
    ? value.map((item: unknown) => (isJsonObject(item) ? map(item) : item))
    : value;
}

function redactMcpServer(server: JsonObject): JsonObject {
  return redactHeaderValues(
    redactFields(server, ['authorization', 'authorization_token']),
    'headers'
  );
}

function redactShellTool(tool: JsonObject): JsonObject {
  const environment = tool.environment;
  if (!isJsonObject(environment) || !isJsonObject(environment.network_policy)) return tool;
  const networkPolicy = environment.network_policy;
  return {
    ...tool,
    environment: {
      ...environment,
      network_policy: {
        ...networkPolicy,
        domain_secrets: mapObjectArray(networkPolicy.domain_secrets, secret =>
          redactFields(secret, ['value'])
        ),
      },
    },
  };
}

function redactTool(tool: JsonObject): JsonObject {
  switch (tool.type) {
    // OpenAI, xAI, Groq and OpenRouter Responses remote MCP and connectors, and the Gemini
    // Interactions API
    // https://developers.openai.com/api/docs/guides/tools-connectors-mcp
    // https://docs.x.ai/docs/guides/tools/remote-mcp-tools
    // https://console.groq.com/docs/tool-use/remote-mcp
    // https://ai.google.dev/api/interactions-api
    case 'mcp':
    case 'mcp_server':
      return redactMcpServer(tool);
    // https://openrouter.ai/openapi.json (McpServerToolParameters)
    case 'openrouter:mcp':
      return isJsonObject(tool.parameters)
        ? { ...tool, parameters: redactMcpServer(tool.parameters) }
        : tool;
    // https://developers.openai.com/api/docs/guides/tools-shell
    case 'shell':
      return redactShellTool(tool);
    default:
      return tool;
  }
}

// Azure OpenAI On Your Data
// https://learn.microsoft.com/en-us/azure/ai-foundry/openai/references/azure-search
// https://learn.microsoft.com/en-us/azure/ai-foundry/openai/references/elasticsearch
// https://learn.microsoft.com/en-us/azure/ai-foundry/openai/references/mongo-db
// https://learn.microsoft.com/en-us/azure/ai-foundry/openai/references/cosmos-db
const AZURE_DATA_SOURCE_SECRET_FIELDS = [
  'key',
  'key_id',
  'access_token',
  'encoded_api_key',
  'password',
  'connection_string',
] as const;

function redactAzureAuthentication(object: JsonObject): JsonObject {
  return isJsonObject(object.authentication)
    ? {
        ...object,
        authentication: redactFields(object.authentication, AZURE_DATA_SOURCE_SECRET_FIELDS),
      }
    : object;
}

function redactDataSource(dataSource: JsonObject): JsonObject {
  const parameters = dataSource.parameters;
  if (!isJsonObject(parameters)) return dataSource;
  const redactedParameters = redactAzureAuthentication(parameters);
  return {
    ...dataSource,
    parameters: isJsonObject(parameters.embedding_dependency)
      ? {
          ...redactedParameters,
          embedding_dependency: redactAzureAuthentication(parameters.embedding_dependency),
        }
      : redactedParameters,
  };
}

// https://vercel.com/docs/ai-gateway/authentication-and-byok/byok
function redactProviderOptions(providerOptions: unknown): unknown {
  if (!isJsonObject(providerOptions)) return providerOptions;
  const gateway = providerOptions.gateway;
  if (!isJsonObject(gateway) || !isJsonObject(gateway.byok)) return providerOptions;
  const redactedByok = Object.fromEntries(
    Object.entries(gateway.byok).map(([provider, credentials]) => [
      provider,
      Array.isArray(credentials) ? credentials.map(() => ({ apiKey: REDACTED })) : REDACTED,
    ])
  );
  return { ...providerOptions, gateway: { ...gateway, byok: redactedByok } };
}

/**
 * Redacts credentials that clients embed in documented, structured request fields. String
 * content such as messages is logged as-is.
 */
export function redactApiRequestLogRequest(request: GatewayRequest): Record<string, unknown> {
  const body: JsonObject = { ...request.body };
  if (body.providerOptions !== undefined) {
    body.providerOptions = redactProviderOptions(body.providerOptions);
  }
  if (body.tools !== undefined) {
    body.tools = mapObjectArray(body.tools, redactTool);
  }
  // Anthropic MCP connector
  // https://platform.claude.com/docs/en/agents-and-tools/mcp-connector
  if (body.mcp_servers !== undefined) {
    body.mcp_servers = mapObjectArray(body.mcp_servers, redactMcpServer);
  }
  if (body.data_sources !== undefined) {
    body.data_sources = mapObjectArray(body.data_sources, redactDataSource);
  }
  return body;
}
