import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

// Plugins OpenRouter does not bill separately. Every other plugin id, including
// ids added later, is removed from free requests.
const FREE_PLUGIN_IDS: ReadonlySet<string> = new Set(['response-healing', 'context-compression']);

// Without a configured engine, OpenRouter parses PDFs with Mistral OCR, billed
// per page, for models that do not accept files natively.
const FREE_PDF_PARSER_PLUGIN = { id: 'file-parser', pdf: { engine: 'cloudflare-ai' } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFreePlugin(plugin: unknown) {
  return isRecord(plugin) && typeof plugin.id === 'string' && FREE_PLUGIN_IDS.has(plugin.id);
}

function getServerToolType(tool: unknown): string | null {
  if (!isRecord(tool) || typeof tool.type !== 'string') {
    return null;
  }
  return tool.type === 'function' || tool.type === 'custom' ? null : tool.type;
}

/**
 * OpenRouter bills plugins (web search, PDF parsing with OCR) and server tools
 * (`openrouter:*` and their aliases such as `web_search_20250305`) to the
 * gateway's account, even when the model itself is free. Free requests,
 * which include every anonymous request, keep only free plugins and tools the
 * client executes itself.
 */
export function removePaidServerFeatures(
  provider: Provider,
  requestedModel: string,
  requestToMutate: GatewayRequest,
  userId: string
) {
  const body: { plugins?: unknown; tools?: unknown; tool_choice?: unknown } = requestToMutate.body;
  const { plugins, tools, tool_choice } = body;

  const requestedPlugins: unknown[] =
    plugins === undefined || plugins === null ? [] : Array.isArray(plugins) ? plugins : [plugins];
  const removedPlugins = requestedPlugins.filter(plugin => !isFreePlugin(plugin));
  const keptPlugins = [
    ...requestedPlugins.filter(isFreePlugin),
    ...(provider.id === 'openrouter' ? [FREE_PDF_PARSER_PLUGIN] : []),
  ];
  if (keptPlugins.length > 0) {
    body.plugins = keptPlugins;
  } else {
    delete body.plugins;
  }

  const removedToolTypes = Array.isArray(tools)
    ? tools.map(getServerToolType).filter(type => type !== null)
    : [];
  if (Array.isArray(tools) && removedToolTypes.length > 0) {
    const keptTools = tools.filter(tool => getServerToolType(tool) === null);
    if (keptTools.length > 0) {
      body.tools = keptTools;
    } else {
      delete body.tools;
    }
    const forcesRemovedTool =
      isRecord(tool_choice) &&
      typeof tool_choice.type === 'string' &&
      removedToolTypes.includes(tool_choice.type);
    if (keptTools.length === 0 || forcesRemovedTool) {
      delete body.tool_choice;
    }
  }

  if (removedPlugins.length === 0 && removedToolTypes.length === 0) {
    return;
  }
  console.warn('[applyProviderSpecificLogic] Removed paid server features from free request', {
    userId,
    model: requestedModel,
    requestKind: requestToMutate.kind,
    removedPlugins,
    removedToolTypes,
  });
}
