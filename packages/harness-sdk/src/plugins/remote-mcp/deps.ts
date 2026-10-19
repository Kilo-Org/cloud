import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  jsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation/types.js';
import type {
  RemoteMcpAbort,
  RemoteMcpRequest,
} from './http.js';
import type { RemoteMcpToken } from './credential.js';
import type { RemoteMcpError } from './server.js';

/**
 * Everything one operation runs under, handed in by the caller. The interface
 * lives apart from the client value so both the client and the opener read the
 * same contract without one importing the other's runtime.
 */
interface RemoteMcpClientDeps {
  /**
   * The runtime's `fetch`, passed in rather than read off a global, so the same
   * plugin runs in a browser, on Node and in a mobile app. It is a method here
   * on purpose: a caller holding the DOM's own `fetch` satisfies it without a
   * cast, which a property of function type would not allow.
   */
  fetch(url: string | URL, init?: RemoteMcpRequest): Promise<Response>;
  /**
   * The credential for one call, asked each time so a refreshed token is used
   * instead of the one the process started with. It fails with a
   * `RemoteMcpError`, so a source that can fail names the kind. Read only for
   * `bearer`.
   */
  token?: RemoteMcpToken;
  /**
   * The library's OAuth provider for this server: where its tokens, client
   * registration and PKCE verifier are kept. Read only for `oauth`. The
   * transport refreshes an expired token through it, and a server that needs a
   * person to sign in again calls its `redirectToAuthorization` and fails
   * `unauthorized`.
   */
  authProvider?: OAuthClientProvider;
  /** The caller's own signal, linked into the deadline of every request. */
  signal?: RemoteMcpAbort;
  /**
   * How long one operation may take. A call gets 60 seconds by default, longer
   * than the 15 seconds a remote tool is waited on inline, so a call the
   * session backgrounds still answers. Discovery gets 15.
   */
  timeoutMs?: number;
  /** How long tool discovery may take. The per-operation `timeoutMs` by default. */
  discoverTimeoutMs?: number;
  /** Replaces the permissive validator, for a runtime that can run Ajv. */
  jsonSchemaValidator?: jsonSchemaValidator;
  /** Told about a call the server did not answer: unreachable, refused the
      credential, or gone. A `protocol` failure is the server answering wrongly,
      so it is not one; a person's screen never sees the model's tool result. */
  onCallFailure?: (error: RemoteMcpError) => void;
}

export type { RemoteMcpClientDeps };
