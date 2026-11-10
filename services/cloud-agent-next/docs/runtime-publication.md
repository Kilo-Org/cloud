# Runtime publication

The publisher is `pnpm runtime:publish`. Local packaging and CI use the same command.

- Local directory: `pnpm runtime:publish --out /tmp/runtime-release`.
- Local Wrangler R2: `pnpm runtime:publish --local`.
- CI: `pnpm runtime:publish --bucket "$RUNTIME_R2_BUCKET" --source-sha "$SOURCE_SHA"`.

Without `--cli` or `--cli-version`, an invocation packages two releases with one control payload:
the pinned Kilo v1 CLI and the pinned Kilo v2 CLI (`PINNED_CLIS` in `scripts/runtime-cli-artifact.ts`).
The handoff records both descriptors. `--cli` or `--cli-version` selects one explicit release instead.
Use `--cli-executable` with either flag to override that release's executable path.

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
- `runtime-artifacts/v1/sources/cli-linux-x64-baseline-<version>-<sha256>.tgz`: the verified pinned CLI
  tarball. Publication downloads it from npm only when this object is missing, and accepts a cached copy
  only when it matches the pinned SHA-256. A version bump with a stale digest misses the cache and fails
  the registry check.

Transfers retry bounded transport failures, including timeouts while a body is streaming. Definitive
answers, such as a missing bucket or a 404 from the registry, fail without retrying.

The Worker configuration contains the descriptor's 64-character SHA-256 in
`RUNTIME_RELEASE_DESCRIPTOR`. The Worker reads the full descriptor through its private R2 binding
and verifies its size and hash before use. This keeps the configuration below
[Cloudflare's 5 KB variable limit](https://developers.cloudflare.com/workers/platform/limits/#environment-variables).
Existing allocations with inline descriptors remain supported.

Branch changes and deletion do not remove these objects. This stack adds no garbage collection.

The separate publication workflow validates the repository, CI workflow identity, run event, main
branch, successful conclusion and exact SHA through GitHub metadata before it receives write credentials.
It checks out that SHA and installs only the publisher and wrapper dependency graphs. PR, fork, merge-group and failed CI runs cannot publish. Publication serializes
retries of the same SHA. Different SHAs publish concurrently, independently of deployment.
Concurrent base builds retain the first verified digest for their shared input identity.
Each publisher verifies that retained digest before use. A Worker-only SHA still creates its own handoff.

Publication requires these approved and provisioned resources:

- A private runtime R2 bucket, separate from session storage. Keep public access disabled.
- Repository variables `CLOUD_AGENT_RUNTIME_ACCOUNT_ID` and `CLOUD_AGENT_RUNTIME_BUCKET`.
- Environment `cloud-agent-runtime-publication`, with a deployment branch policy restricted to `main`.
- Repository secrets `CLOUD_AGENT_RUNTIME_R2_ACCESS_KEY_ID` and
  `CLOUD_AGENT_RUNTIME_R2_SECRET_ACCESS_KEY`, with bucket-scoped object read/write permission.
  The publisher performs no deletes. Publication and deployment use the same pair.
- Repository secret `CLOUDFLARE_API_TOKEN` with permission to push to the selected account's container
  registry. The publisher reuses the existing deploy token.

An automatic run publishes only when `runtime-targets.json` at the source SHA has a downloaded default
or named target. The admission job reads that catalog through the GitHub API for the exact SHA.
A preinstalled-only catalog skips the publish job. With the checked-in downloaded default, every
eligible successful main-push CI run publishes its exact-SHA handoff, even without runtime changes.
The publisher reuses a verified cached base when its inputs have not changed.

A manual `workflow_dispatch` run accepts an exact main SHA and requires a successful trusted CI push
run for that SHA. A manual run publishes whatever the catalog contains.
The admission checkout and the publication environment are restricted to `main`.

Publication does not change startup selection; the catalog does. Publication does not provision
credentials or deploy the Worker.

`runtime-targets.json` owns target mode/image selection. See [runtime-rollout.md](runtime-rollout.md)
for rendering, isolated qualification and rollback.

Downloaded deployment preparation uses the exact checked-out source SHA. The same downloaded catalog
starts publication for that SHA after its CI succeeds. Preparation waits at most 45 minutes for that SHA's handoff
without holding the publisher's concurrency lock. Publication runs are titled with their source SHA,
so preparation reads their state with the deploy's read-only token. While any run for the SHA is
queued or running, including a re-run, preparation keeps waiting. Before any run exists, preparation
also keeps waiting while the SHA's main push CI is queued or running. When every run has finished without
a handoff, or no run starts within 10 minutes of that CI succeeding, preparation fails immediately with
the run links and the `workflow_dispatch` command, instead of holding the deployment for the full wait.
A SHA without a successful main CI run fails after 10 minutes of waiting, since it cannot publish.
If run state cannot be read, preparation keeps waiting within the same bound. It checks source identity,
base inputs, stored payload bytes, compatibility and target image configuration before Wrangler or
its custom build can run. Runtime-free targets use the recorded registry digest. Registry credentials
stay in a temporary Docker configuration, which the command removes on exit.

Preinstalled deployments make no runtime storage request and require no publisher credentials.
The Worker deployment matrix does not cancel unrelated jobs when one target fails.

The deployment selector can choose an earlier successful CI commit. A checkout that predates both
runtime preparation and its target catalog keeps the ordinary preinstalled deployment path. A present
catalog still requires preparation, so a missing current script cannot bypass the deployment checks.
