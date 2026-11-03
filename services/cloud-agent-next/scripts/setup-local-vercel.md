# Local Vercel testing

Start this worktree's local Cloud Agent stack. Sign in with the seeded local
account. In **Cloud → Settings → Compute → Vercel**, select the test team and
project. The command below repairs an existing personal connection.

Put the token in the repository root `.env.vercel-test.local`:

```dotenv
VERCEL_TOKEN=your-token
VERCEL_TEAM_ID=
VERCEL_PROJECT_ID=
```

Empty team and project fields use the selection saved in Compute settings.
If supplied, both fields must match that selection.

Run from the repository root:

```sh
pnpm exec tsx services/cloud-agent-next/scripts/setup-local-vercel.ts evgeny@kilocode.ai
pnpm dev:restart cloud-agent-next
pnpm dev:restart nextjs
```

Before retrying, configure a reachable worker callback URL as described below.
Then refresh Compute settings and select **Retry setup** if setup previously failed.
Use your local account email in place of the example email when necessary.

The command checks the selected project's API access and the worktree's local
database port. It creates a local RSA key pair in `.env.vercel-test.keys.local`,
sets the worker private key and web development public key, enrolls the selected
user, and encrypts the token in the existing local connection. Repeated runs reuse
the same keys. It refuses to replace an unrelated configured worker private key.

Both token and key files are ignored by Git. Keep them private. The token stays
in the local control plane; the command does not put it in a sandbox. This command
does not create a public tunnel, deploy services, or change production settings.

Local setup and provider containment are separate checks. Both passed for the
GitHub test repository on this branch. Vercel callbacks require a reachable worker
URL; a local-only hostname is insufficient.

## Interactive local UI tests

Open `http://localhost:<web-port>/cloud` using the web port from `pnpm dev:status`.
Use the personal account whose email you supplied to the repair command. Open
**Settings → Compute → Vercel**.

A Vercel sandbox cannot reach `host.docker.internal` on your computer. Keep a
worker tunnel running throughout setup and any subsequent Vercel session tests.
Set only `WORKER_URL` in `services/cloud-agent-next/.dev.vars` to that public HTTPS
URL, restart `cloud-agent-next`, and wait for the worker to respond before retrying.
The web UI itself can remain on localhost.

Use **Retry setup** after a failed build. It creates a new build generation and
runtime identity. Reusing the failed generation can select an expired provider
sandbox and fail with HTTP 410.

When testing ends, restore the previous `WORKER_URL`, restart this worktree's
worker, and stop the exact tunnel process. A completed snapshot stays saved in
the local connection. Later Vercel sessions still require a reachable callback URL.

## Verification on 2026-11-02

The local repair command passed twice with the same key pair. With a temporary
worker tunnel and a new build generation, setup completed with status `ready`.
The runtime snapshot passed validator call-home verification, and the validator
stopped successfully. The tunnel remains open for the requested interactive UI
test until the user requests shutdown.

A separate temporary sandbox verified these provider properties:

- Nonpersistent sandbox creation, Node 24 execution, and explicit shutdown.
- No `VERCEL_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` environment variables.
- Forwarding tokens have valid RS256 signatures against the issuer's JWKS.
- The issuer is `https://oidc.vercel.com/<team-id>`. The audience is the exact
  forwarding URL. `sandbox_id` is the session ID; `sandbox_name` is its logical name.
- Forwarding preserves an encoded path segment and the query string.
- POST requests and responses of 1 MiB and 8 MiB pass through the forwarding path.

These size checks establish tested sizes, not a maximum provider limit. The probe
did not test a complete managed Git session. Its sandbox, tunnel, and callback
listener were stopped. Quick-tunnel DNS needed time to propagate; checking the
public hostname immediately returned a temporary DNS failure.

The completed GitHub session also verified clone, fetch, push dry-run, model
response, and a `package.json` read. The process environment contained no raw
provider credentials, and the Git remote used a scoped alias. Invalid aliases
returned 403. Missing provider identity and a different sandbox's signed identity
returned 401. The push dry-run did not publish a branch or commit.

These checks used `na2-org/hi-how-are-you`. Live GitLab, Bitbucket, maximum payload
sizes, and long-duration forwarding were not verified. Local activation does not
mean production deployment or complete provider-limit compatibility verification.
