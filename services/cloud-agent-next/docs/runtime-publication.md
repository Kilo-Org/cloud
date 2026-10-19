# Runtime publication

The publisher is `pnpm runtime:publish`. Local packaging and CI use the same command.

- Local directory: `pnpm runtime:publish --out /tmp/runtime-release`.
- Local Wrangler R2: `pnpm runtime:publish --local`.
- CI: `pnpm runtime:publish --bucket "$RUNTIME_R2_BUCKET" --source-sha "$SOURCE_SHA"`.

Every invocation rebuilds wrapper output. Payload hashes identify the output bytes. The publisher
creates immutable objects, reads them back, and publishes the descriptor last. An exact-SHA handoff
is published only after the runtime-free base and real CLI/wrapper compatibility check pass.

`Dockerfile.containers.runtime-free` contains generic tools and the initial entrypoint. It has no
Kilo CLI, wrapper, supervisor or credential helper. Its input identity covers the runtime ABI, Dockerfile and
`linux/amd64`. The recipe has no COPY or ADD inputs. Adding one requires extending the declared
context inputs and their hashes first. CLI, wrapper and Worker changes do not change this identity.
A base recipe change creates a new immutable registry digest. A cached digest is pulled and verified.
Upstream package updates require an explicit recipe change; the publisher does not refresh a cached base.

Retained objects use these keys in the private runtime bucket:

- `runtime-artifacts/v1/objects/<sha256>`: compressed payloads.
- `runtime-artifacts/v1/releases/<sha256>.json`: release descriptors.
- `runtime-artifacts/v1/bases/<input-id>.json`: immutable base references.
- `runtime-artifacts/v1/handoffs/<source-sha>.json`: source, base, descriptor, compatibility and payload references.

The Worker configuration contains the descriptor's 64-character SHA-256 in
`RUNTIME_RELEASE_DESCRIPTOR`. The Worker reads the full descriptor through its private R2 binding
and verifies its size and hash before use. This keeps the configuration below
[Cloudflare's 5 KB variable limit](https://developers.cloudflare.com/workers/platform/limits/#environment-variables).
Existing allocations with inline descriptors remain supported.

Branch changes and deletion do not remove these objects. This stack adds no garbage collection.

The separate publication workflow validates the repository, CI workflow identity, run event, main
branch, successful conclusion and exact SHA through GitHub metadata before it receives write credentials.
It checks out that SHA. PR, fork, merge-group and failed CI runs cannot publish. Publication serializes
retries of the same SHA. Different SHAs publish concurrently, independently of deployment.
Concurrent base builds retain the first verified digest for their shared input identity.
Each publisher verifies that retained digest before use. A Worker-only SHA still creates its own handoff.

The trigger stays disabled until infrastructure owners approve and provision:

- A private runtime R2 bucket, separate from session storage. Keep public access disabled.
- Repository variables `CLOUD_AGENT_RUNTIME_ACCOUNT_ID` and `CLOUD_AGENT_RUNTIME_BUCKET`.
- Environment `cloud-agent-runtime-publication`, with its required reviewers.
- Secrets `CLOUD_AGENT_RUNTIME_R2_WRITE_ACCESS_KEY_ID` and `CLOUD_AGENT_RUNTIME_R2_WRITE_SECRET_ACCESS_KEY`,
  with the minimum bucket-scoped object write/read permissions. The publisher performs no deletes.
- Secret `CLOUD_AGENT_RUNTIME_REGISTRY_PUBLISH_TOKEN`, restricted to the selected account's registry.
- Deployment read credentials `CLOUD_AGENT_RUNTIME_R2_READ_ACCESS_KEY_ID` and
  `CLOUD_AGENT_RUNTIME_R2_READ_SECRET_ACCESS_KEY`, restricted to the same bucket.
- Finally, repository variable `CLOUD_AGENT_RUNTIME_PUBLICATION_ENABLED=true`.

No resources or credentials were provisioned by this change. No deployed target selects downloaded startup.

Downloaded deployment preparation uses the exact checked-out source SHA. It fails at once when the
enablement variable is not `true`. Otherwise it waits at most 45 minutes for that SHA's handoff
without holding the publisher's concurrency lock. It checks source identity,
base inputs, stored payload bytes, compatibility and target image configuration before Wrangler or
its custom build can run. Runtime-free targets use the recorded registry digest. Registry credentials
stay in a temporary Docker configuration, which the command removes on exit.

Preinstalled deployments make no runtime storage request and require no publisher credentials.
The Worker deployment matrix does not cancel unrelated jobs when one target fails.

The deployment selector can choose an earlier successful CI commit. A checkout that predates both
runtime preparation and its target catalog keeps the ordinary preinstalled deployment path. A present
catalog still requires preparation, so a missing current script cannot bypass the deployment checks.
