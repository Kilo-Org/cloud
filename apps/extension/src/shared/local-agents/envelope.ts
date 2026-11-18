/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { z } from 'zod';
import { parseJsonRpcMessage } from './jsonrpc';
import type { JsonRpcMessage, JsonRpcWireMessage } from './jsonrpc';

/*
 * Hub <-> extension envelope (SPEC "Transport / Hub"). Both transports carry
 * one JSON object per frame, discriminated by `type`. The extension only
 * accepts hub.hello, controller lifecycle frames, and rpc frames; anything else
 * is a protocol violation and drops the connection.
 */

export const LOCAL_AGENT_PROTOCOL_VERSION = 1;

/**
 * The vendored contract's own header carries this value (`Raw tools/list JSON
 * SHA-256` in `browser-tool-contract.ts`). A unit test asserts the two agree so
 * a contract regeneration cannot silently change what the extension announces.
 */
export const BROWSER_TOOL_CONTRACT_SHA =
  '6ee94e2fca227ae0a6304c476e20731acf4650f1f5856c9cf7b734a368fcadda';

export type LocalAgentCapabilities = {
  trustedInput: boolean;
  console: boolean;
  network: boolean;
  dialogs: boolean;
  fileUpload: boolean;
  tabGroups: boolean;
};

export type LocalAgentExtensionHello = {
  type: 'ext.hello';
  protocol: number[];
  extensionVersion: string;
  browser: { name: string; version: string };
  profileLabel: string;
  contractSha: string;
  capabilities: LocalAgentCapabilities;
};

export type LocalAgentTransport = 'native' | 'loopback';

export type LocalAgentHubHello = {
  type: 'hub.hello';
  protocol: number[];
  hubVersion: string;
  mode: LocalAgentTransport;
};

export type LocalAgentIncomingEnvelope =
  | { type: 'controller.connected'; controllerId: string }
  | { type: 'controller.disconnected'; controllerId: string }
  | { type: 'rpc'; controllerId: string; message: JsonRpcMessage };

export type LocalAgentOutgoingEnvelope =
  | LocalAgentExtensionHello
  | { type: 'rpc'; controllerId: string; message: JsonRpcWireMessage };

const protocolSchema = z.array(z.number().int());

const capabilitiesSchema = z.object({
  console: z.boolean(),
  dialogs: z.boolean(),
  fileUpload: z.boolean(),
  network: z.boolean(),
  tabGroups: z.boolean(),
  trustedInput: z.boolean(),
});

const extensionHelloSchema = z.object({
  browser: z.object({ name: z.string(), version: z.string() }),
  capabilities: capabilitiesSchema,
  contractSha: z.string(),
  extensionVersion: z.string(),
  profileLabel: z.string(),
  protocol: protocolSchema,
  type: z.literal('ext.hello'),
});

const hubHelloSchema = z.object({
  hubVersion: z.string(),
  mode: z.enum(['native', 'loopback']),
  protocol: protocolSchema,
  type: z.literal('hub.hello'),
});

const controllerConnectedSchema = z.object({
  controllerId: z.uuid(),
  type: z.literal('controller.connected'),
});

const controllerDisconnectedSchema = z.object({
  controllerId: z.uuid(),
  type: z.literal('controller.disconnected'),
});

const rpcEnvelopeSchema = z.object({
  controllerId: z.uuid(),
  message: z.record(z.string(), z.unknown()),
  type: z.literal('rpc'),
});

export const parseHubHello = (value: unknown): LocalAgentHubHello | null => {
  const parsed = hubHelloSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
};

export const parseExtensionHello = (value: unknown): LocalAgentExtensionHello | null => {
  const parsed = extensionHelloSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
};

/** Parses one frame from the hub; null means the frame is not protocol v1. */
export const parseIncomingEnvelope = (value: unknown): LocalAgentIncomingEnvelope | null => {
  const connected = controllerConnectedSchema.safeParse(value);

  if (connected.success) {
    return { controllerId: connected.data.controllerId, type: 'controller.connected' };
  }

  const disconnected = controllerDisconnectedSchema.safeParse(value);

  if (disconnected.success) {
    return { controllerId: disconnected.data.controllerId, type: 'controller.disconnected' };
  }

  const rpc = rpcEnvelopeSchema.safeParse(value);

  if (rpc.success) {
    const message = parseJsonRpcMessage(rpc.data.message);

    return message === null ? null : { controllerId: rpc.data.controllerId, message, type: 'rpc' };
  }

  return null;
};

export const buildExtensionHello = ({
  browser,
  capabilities,
  extensionVersion,
  profileLabel,
}: {
  browser: { name: string; version: string };
  capabilities: LocalAgentCapabilities;
  extensionVersion: string;
  profileLabel: string;
}): LocalAgentExtensionHello => ({
  browser,
  capabilities,
  contractSha: BROWSER_TOOL_CONTRACT_SHA,
  extensionVersion,
  profileLabel,
  protocol: [LOCAL_AGENT_PROTOCOL_VERSION],
  type: 'ext.hello',
});

export const buildRpcEnvelope = (
  controllerId: string,
  message: JsonRpcWireMessage
): LocalAgentOutgoingEnvelope => ({ controllerId, message, type: 'rpc' });
