import { createHash, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

export function createBillingStub(
  checkAssertion: (clientId: string, assertion: unknown) => string | null
) {
  type Par = {
    clientId: string;
    profileId: string;
    redirectUri: string;
    state: string;
    challenge: string;
    expiresAt: number;
  };
  type Approval = Par & { organization: string };
  const requests = new Map<string, Par>();
  const codes = new Map<string, Approval>();
  const profiles = new Map<
    string,
    { id: string; organization: string | null; connection: string | null }
  >();
  const tokens = new Set<string>();
  let refusal = '';
  let tokenError = '';
  let overloads = 0;

  function send(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }
  function redirect(response: ServerResponse, target: URL) {
    response.writeHead(302, { location: target.toString() });
    response.end();
  }
  function text(value: unknown) {
    return typeof value === 'string' ? value : '';
  }

  return async function handle(
    method: string,
    url: URL,
    body: Record<string, unknown>,
    raw: string,
    authorization: string | undefined,
    profileHeader: string | undefined,
    beta: string | undefined,
    response: ServerResponse
  ) {
    if (method === 'POST' && url.pathname === '/test/config') {
      refusal = text(body.refusal);
      tokenError = text(body.tokenError);
      overloads = typeof body.overloads === 'number' ? body.overloads : 0;
      send(response, 200, { ok: true });
      return true;
    }
    if (method === 'GET' && url.pathname === '/test/profiles') {
      send(response, 200, [...profiles.values()]);
      return true;
    }
    if (
      method === 'POST' &&
      url.pathname === '/v1/oauth/token' &&
      body.grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer'
    ) {
      const error = checkAssertion('operator', body.assertion);
      if (
        error ||
        body.organization_id !== process.env.CLAUDE_OPERATOR_ORGANIZATION_ID ||
        body.service_account_id !== process.env.CLAUDE_OPERATOR_SERVICE_ACCOUNT_ID ||
        body.federation_rule_id !== process.env.CLAUDE_OPERATOR_FEDERATION_RULE_ID
      ) {
        send(response, 401, {
          type: 'error',
          error: { type: 'authentication_error', message: 'Authentication failed' },
        });
      } else {
        const token = `mock-operator-${randomUUID()}`;
        tokens.add(token);
        send(response, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
      }
      return true;
    }
    if (method === 'POST' && url.pathname === '/v1/oauth/par') {
      const error = checkAssertion(text(body.client_id), body.client_assertion);
      if (
        error ||
        body.scope !== 'org:billing_attribution' ||
        body.connection_type !== 'organization_shared' ||
        body.code_challenge_method !== 'S256' ||
        !profiles.has(text(body.user_profile_id))
      ) {
        send(response, 400, { error: error ? 'invalid_client' : 'invalid_request' });
        return true;
      }
      const requestUri = `urn:ietf:params:oauth:request_uri:${randomUUID()}`;
      requests.set(requestUri, {
        clientId: text(body.client_id),
        profileId: text(body.user_profile_id),
        redirectUri: text(body.redirect_uri),
        state: text(body.state),
        challenge: text(body.code_challenge),
        expiresAt: Date.now() + 600_000,
      });
      send(response, 201, { request_uri: requestUri, expires_in: 600 });
      return true;
    }
    if (
      method === 'GET' &&
      url.pathname === '/oauth/authorize' &&
      url.searchParams.has('request_uri')
    ) {
      const uri = url.searchParams.get('request_uri') ?? '';
      const par = requests.get(uri);
      if (
        !par ||
        par.expiresAt < Date.now() ||
        par.clientId !== url.searchParams.get('client_id')
      ) {
        send(response, 400, { error: 'invalid_request' });
      } else {
        response.writeHead(200, { 'content-type': 'text/html' });
        const organization = (
          profiles.get(par.profileId)?.organization ?? `org-${uri.slice(-12)}`
        ).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
        response.end(
          `<!doctype html><h1>Link your Claude organization</h1><p>Approve billing Claude requests from Kilo to your API organization.</p><form method="post" action="/oauth/billing/decision"><input name="request_uri" type="hidden" value="${uri}"><label>Claude organization <input name="organization" value="${organization}"></label><button name="decision" value="approve">Approve</button><button name="decision" value="decline">Decline</button></form>`
        );
      }
      return true;
    }
    if (method === 'POST' && url.pathname === '/oauth/billing/decision') {
      const form = new URLSearchParams(raw);
      const uri = form.get('request_uri') ?? '';
      const par = requests.get(uri);
      requests.delete(uri);
      if (!par || par.expiresAt < Date.now()) {
        send(response, 400, { error: 'invalid_request' });
        return true;
      }
      const target = new URL(par.redirectUri);
      target.searchParams.set('state', par.state);
      const organization = form.get('organization') ?? '';
      const conflict = [...profiles.values()].some(
        profile => profile.id !== par.profileId && profile.organization === organization
      );
      const existingOrganization = profiles.get(par.profileId)?.organization;
      if (
        form.get('decision') !== 'approve' ||
        (existingOrganization && existingOrganization !== organization)
      )
        target.searchParams.set('error', 'access_denied');
      else if (conflict) target.searchParams.set('error', 'user_profile_already_linked');
      else {
        const code = randomUUID();
        codes.set(code, { ...par, organization, expiresAt: Date.now() + 300_000 });
        target.searchParams.set('code', code);
      }
      redirect(response, target);
      return true;
    }
    if (
      method === 'POST' &&
      url.pathname === '/v1/oauth/token' &&
      body.client_id === process.env.CLAUDE_BILLING_CLIENT_ID
    ) {
      const error = checkAssertion(text(body.client_id), body.client_assertion);
      const approval = codes.get(text(body.code));
      codes.delete(text(body.code));
      if (
        error ||
        !approval ||
        approval.expiresAt < Date.now() ||
        body.redirect_uri !== approval.redirectUri ||
        createHash('sha256').update(text(body.code_verifier)).digest('base64url') !==
          approval.challenge
      ) {
        send(response, 400, { error: error ? 'invalid_client' : 'invalid_grant' });
      } else if (tokenError) {
        send(response, 400, { error: tokenError });
      } else {
        const profile = profiles.get(approval.profileId);
        if (!profile) {
          send(response, 400, { error: 'invalid_request' });
          return true;
        }
        const conflict = [...profiles.values()].some(
          other => other.id !== profile.id && other.organization === approval.organization
        );
        if (conflict || (profile.organization && profile.organization !== approval.organization)) {
          send(response, 400, { error: 'user_profile_already_linked' });
          return true;
        }
        profile.organization = approval.organization;
        profile.connection ??= `ocon_${randomUUID()}`;
        send(response, 200, {
          connection_id: profile.connection,
          access_token: 'mock-metadata-only',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'org:billing_attribution',
        });
      }
      return true;
    }
    if (!url.pathname.startsWith('/v1/')) return false;
    if (
      !['/v1/user_profiles', '/v1/models', '/v1/messages', '/v1/chat/completions'].includes(
        url.pathname
      ) &&
      !url.pathname.startsWith('/v1/user_profiles/')
    )
      return false;
    if (!tokens.has((authorization ?? '').replace(/^Bearer /, ''))) {
      send(response, 401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'Authentication failed' },
      });
      return true;
    }
    if (method === 'POST' && url.pathname === '/v1/user_profiles') {
      const id = `uprof_${randomUUID()}`;
      profiles.set(id, { id, organization: null, connection: null });
      send(response, 200, {
        id,
        type: 'user_profile',
        name: null,
        metadata: {},
        external_user_details: {},
        access_type: 'application',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        programs: {},
      });
      return true;
    }
    if (method === 'DELETE' && url.pathname.startsWith('/v1/user_profiles/')) {
      const id = url.pathname.split('/').at(-1) ?? '';
      send(response, profiles.delete(id) ? 200 : 404, { id, type: 'user_profile_deleted' });
      return true;
    }
    if (method === 'GET' && url.pathname === '/v1/models') {
      send(response, 200, {
        data: [
          {
            id: 'claude-sonnet-4-6',
            type: 'model',
            display_name: 'Claude Sonnet',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        has_more: false,
        first_id: 'claude-sonnet-4-6',
        last_id: 'claude-sonnet-4-6',
      });
      return true;
    }
    const profile = profiles.get(profileHeader ?? '');
    const policy = body.billing_policy;
    if (
      !profile?.connection ||
      !beta?.includes('user-profiles-billing-2026-10-01') ||
      typeof policy !== 'object' ||
      policy === null ||
      !('bill_to' in policy) ||
      policy.bill_to !== 'user_profile'
    ) {
      send(response, 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Missing billing policy or profile' },
      });
      return true;
    }
    const compat = url.pathname === '/v1/chat/completions';
    const code = overloads-- > 0 ? 'overloaded' : refusal;
    if (code) {
      const status = code === 'overloaded' ? 503 : code === 'user_profile_not_billable' ? 403 : 402;
      const type =
        status === 503 ? 'overloaded_error' : status === 403 ? 'permission_error' : 'billing_error';
      if (status === 503) response.setHeader('retry-after', '0');
      send(
        response,
        status,
        compat
          ? { error: { type: 'invalid_request_error', code: type, message: code } }
          : { type: 'error', error: { type, message: code, details: { error_code: code } } }
      );
      return true;
    }
    const id = `msg_${randomUUID()}`;
    const message = {
      id,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text: 'Local Claude billing proof.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 6,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
    if (body.stream && !compat) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [event, data] of [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              ...message,
              content: [],
              stop_reason: null,
              usage: { ...message.usage, output_tokens: 0 },
            },
          },
        ],
        [
          'content_block_start',
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ],
        [
          'content_block_delta',
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Local Claude billing proof.' },
          },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 6 },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ])
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      response.end();
    } else if (compat) {
      send(response, 200, {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Local Claude billing proof.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      });
    } else send(response, 200, message);
    return true;
  };
}
