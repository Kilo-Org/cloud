// src/types.ts

// ============================================
// Environment Types
// ============================================
import type { Sandbox } from '@cloudflare/sandbox';

export const DEFAULT_SANDBOX_PORT = 8080;

/**
 * Type for the AdminRPCEntrypoint service binding from cloudflare-db-proxy.
 * Combines base Fetcher capabilities with the RPC methods exposed by the entrypoint.
 */
type AdminRPCService = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  connect(address: SocketAddress | string, options?: SocketOptions): Socket;
  provision(appId: string): Promise<{ token: string; isNew: boolean }>;
};

export interface Env extends Omit<CloudflareEnv, 'SANDBOX' | 'DB_PROXY'> {
  SANDBOX: DurableObjectNamespace<Sandbox<unknown>>;
  DB_PROXY: AdminRPCService;
}

// ============================================
// Git Repository Types
// ============================================
export interface GitObject {
  path: string;
  data: string;
}

export interface RepositoryStats {
  totalObjects: number;
  totalBytes: number;
  largestObject: { path: string; size: number } | null;
  initialized: boolean;
}

// ============================================
// Git Service Types
// ============================================
export interface SqlExecutor {
  <T = unknown>(query: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[];
}

export interface RepositoryBuildOptions {
  gitObjects: Array<{ path: string; data: Uint8Array }>;
}

export interface RefUpdate {
  oldOid: string;
  newOid: string;
  refName: string;
}

export interface ReceivePackResult {
  success: boolean;
  refUpdates: RefUpdate[];
  errors: string[];
}

// ============================================
// Git Version Control Types
// ============================================
export interface CommitInfo {
  oid: string;
  message: string;
  author: string;
  timestamp: string;
}

export interface FileDiff {
  path: string;
  diff: string;
}

export interface GitShowResult {
  oid: string;
  message: string;
  author: string;
  timestamp: string;
  files: number;
  fileList: string[];
  diffs?: FileDiff[];
}

export interface TreeEntry {
  name: string;
  type: 'blob' | 'tree';
  oid: string;
  mode: string;
}

export interface TreeResult {
  entries: TreeEntry[];
  sha: string;
}

/** Internal git blob result - raw binary content. The DO/API layer converts this to string + encoding. */
export interface BlobResult {
  content: Uint8Array;
  size: number;
  sha: string;
}

// ============================================
// Filesystem Error Types (Node.js-compatible for isomorphic-git)
// ============================================
/**
 * Error interface compatible with Node.js ErrnoException
 * Used by isomorphic-git for filesystem error handling
 */
export interface ErrnoException extends Error {
  code?: string;
  errno?: number;
  path?: string;
  syscall?: string;
}

// ============================================
// Preview Types
// ============================================

/**
 * Possible states for a preview sandbox
 * - uninitialized: DO not configured with appId yet
 * - idle: appId set, no dev server process running
 * - building: dev server process exists, port not yet open
 * - running: dev server process exists AND port is open
 * - error: process failed/killed (auto-clears on next build)
 */
export type PreviewState = 'uninitialized' | 'idle' | 'building' | 'running' | 'error';

/**
 * Database credentials - both fields are always present together
 */
export type DbCredentials = {
  url: string;
  token: string;
};

/**
 * Persisted state that survives DO destruction
 */
export type PreviewPersistedState = {
  appId: string | null; // null = uninitialized
  lastError: string | null; // error message from last failed process
  dbCredentials: DbCredentials | null;
};

/**
 * Response shape for GET /apps/{app_id}/preview endpoint
 */
export interface PreviewStatusResponse {
  status: PreviewState;
  currentCommit: string | null;
  previewUrl: string | null;
  error: string | null;
  appId: string;
}
