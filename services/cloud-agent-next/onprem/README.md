# On-prem Cloud Agent: review-first local setup

**Requirements and permissions → offline manifest preview → explicit approved
installation → Ready.** Your platform administrator reviews and runs the setup;
Kilo does not receive your kubeconfig or direct cluster-admin access.

This is a source-built, local developer preview. Nothing in this directory is a
published installer, image, or Helm chart. Use a dedicated local Kubernetes
context and the repository's local test endpoints for this guide. A dedicated
cluster for agent workloads is the recommended MVP boundary, not an instruction
to modify an existing production cluster's CNI, node runtime or applications.
Support for existing shared clusters with dedicated node pools needs separate
qualification; this installer does not reconfigure them.

The product boundary is **Kilo-hosted coordination with customer-operated
Kubernetes compute**. Running the Kilo web app and services locally is only the
development arrangement used to verify this branch. This is not full Kilo
self-hosting, an air-gapped product, or an AWS/GCP account connector.

## What runs where

| Location | Components | Responsibility |
| --- | --- | --- |
| Kilo control plane | Web settings, organization authorization, session coordination, history and model gateway | Kilo; run the repository's local services for this preview |
| Your Linux/Kubernetes nodes | Kubernetes, containerd, gVisor, Cilium, DNS and node capacity | Operator prerequisite; the application installer does not create the cluster |
| Trusted installation namespace | Kilo provisioner and TLS broker, configuration, installation identity and allocation ledger | Installed/initialized by the Kilo application tooling |
| Task namespace | Short-lived gVisor Pods running the wrapper and Kilo CLI | The provisioner reconciles Pods within preconfigured namespace, resource, admission and network boundaries |

The provisioner polls the control plane for launch/stop operations. A task uses
an outbound control connection and the existing reverse-terminal protocol. The
broker supplies protected credentials outside the task after checking the live
Pod and allocation. Kubernetes credentials, installation credentials and the
broker private key must not enter a task Pod.

## What you approve

Installation privileges and the provisioner's runtime privileges are different.
Your administrator needs permission to apply the reviewed resources. The
installer also reads cluster version, node information, the RuntimeClass, the
Cilium DaemonSet and cluster DNS to check compatibility; it does not modify
those platform components. The provisioner then runs under its own limited
service account; it is not granted `cluster-admin` or `pods/exec`.

| Scope | Installation changes / runtime permissions |
| --- | --- |
| Cluster-scoped installation objects | Two dedicated namespaces with Restricted Pod Security labels, and a named ClusterRole/ClusterRoleBinding for this installation |
| Namespaced installation objects | ServiceAccounts, Roles/RoleBindings, configuration and TLS/enrollment Secrets, public CA ConfigMap, broker Service, quotas/limits, NetworkPolicies and one provisioner/broker Deployment |
| Provisioner: trusted namespace | Get/update the named installation-identity Secret; get/list/create/update/delete allocation ConfigMaps; get the named broker Service |
| Provisioner: task namespace | Get/list/create/patch/delete Pods; get/create/delete task Secrets; get the named public CA ConfigMap |
| Provisioner: cluster scope | Get the configured `gvisor` RuntimeClass; create SelfSubjectAccessReviews to ask Kubernetes about its own access |

The installer does not create or modify nodes, the CNI, runtime binaries or the
RuntimeClass. It refuses to take over existing resources with different ownership
labels. Namespaces alone are not the security boundary for untrusted task code:
the qualified runtime, admission settings and actual network enforcement still
matter. Review the complete generated manifests rather than treating this table
as a substitute for them.

## Prerequisites

### Build and operator machine

- A checkout of this monorepo and its workspace dependencies.
- Node 24, the pnpm version pinned in the root `package.json`, and Bun 1.3.14.
- A Docker engine with Buildx to build the two images locally. Docker is a build
  tool here, not a task runtime or a socket to mount into Pods.
- `kubectl`, OpenSSL, and permission to manage the dedicated local cluster.
- For the verified Apple Silicon reference: Lima and Helm. Lima supplies the
  Linux VM; Helm installs Cilium, not a Kilo application chart.
- Enough space for source dependencies, two image builds, image archives and the
  VM disk. The tested VM has a 60 GiB sparse disk; this is not a general minimum.

Keep kubeconfig and enrollment files private. Do not use a shared or production
Kubernetes context for this preview. Do not change your global Docker context or
replace another project's local services to follow this guide.

### Kubernetes platform

The tested reference is deliberately narrow:

| Component | Verified configuration |
| --- | --- |
| Guest | Ubuntu 24.04 ARM64 |
| Local VM | Lima/VZ, 4 CPUs, 8 GiB RAM, no host-folder mounts or SSH-agent forwarding |
| Kubernetes | K3s `v1.36.3+k3s1` with its bundled containerd |
| Task runtime | gVisor `release-20260817.0`, `systrap`, `RuntimeClass/gvisor` using handler `runsc` |
| Networking | Cilium `1.20.1`, Kubernetes IPAM, VXLAN, veth datapath, socket LB disabled, kube-proxy retained |
| Task resources | 2048Mi task memory limit; maximum one concurrent sandbox allocation in the local reference |

The node needs cgroup v2, suitable BPF/seccomp/overlay/VXLAN support and IPv4
forwarding. For this K3s configuration, Flannel and the bundled network-policy
controller are disabled before Cilium is installed. The reference also disables
Traefik, ServiceLB, Hubble, Envoy and Cilium's L7 proxy. Do not apply these
settings to an existing customer cluster as a generic migration procedure.

Fresh-node preparation requires the complete gVisor bundle, including its
containerd shim and helper binaries, and a configured containerd handler before
registering the RuntimeClass. A RuntimeClass object alone does not install
gVisor. Keep the ordinary runtime available for trusted infrastructure. **Task
Pods must explicitly use gVisor; if its handler is unavailable, startup must
fail rather than fall back to the ordinary runtime (`runc`).** For an existing
reference cluster, verify its configuration; do not replace runtime binaries
or containerd configuration as part of preparing these examples.

Use the 2048Mi task default for the local application, not a smaller diagnostic
Pod limit. A 1024Mi task was killed by the kernel during Kilo session import.
The ConfigMap, LimitRange and ResourceQuota must agree when resource settings
change. The allocation limit is not a rule serializing all chats or prompts.
The tested 8 GiB VM is not a proven minimum for all workloads.

### Network and trust requirements

- Kubernetes DNS must work over both UDP and TCP.
- The provisioner must reach the Kubernetes API and configured control plane.
- Tasks need the approved outbound control and reverse-terminal WebSocket paths,
  broker and DNS access, without direct access to protected upstream services or
  the Kubernetes API.
- The Pod-to-broker network path must preserve the source Pod IP. The broker
  verifies the actual socket peer against fresh native Pod UID/IP and the
  allocation ledger. A general proxy, service mesh or NAT layer cannot be
  assumed compatible with this identity check.
- Git, backend, model-provider and session-ingest destinations must match the
  configured allowlist. Do not use wildcard egress as a workaround.
- TLS verification stays enabled. Only the public CA certificate enters task
  Pods; the broker certificate's private key stays in the trusted namespace.
- `host.lima.internal`, `host.docker.internal`, loopback port forwards and the
  Lima gateway address are development wiring, not customer deployment values.

Qualify actual gVisor execution, missing-runtime failure and allowed/denied
network traffic. Installed manifests or a `Running` Pod are not sufficient
proof of those boundaries. Persistent workspace volumes, multi-node operation,
IPv6 and arbitrary CNI/service-mesh combinations are not qualified by this
preview.

## Setup order

Previewing needs only the source checkout, its dependencies and your non-secret
operator configuration. It does not need a running cluster, kubeconfig or an
enrollment token. You can inspect the intended installation before preparing
infrastructure. Finalize image references and settings, then regenerate and
review the preview before applying.

1. Read the requirements and permission scopes above. For local service wiring,
   inspect `pnpm dev:status --json` and reuse the existing worktree session/ports.
   See [local development](../../../DEVELOPMENT.md) when setup is needed.
2. Prepare the operator configuration and run the offline preview below. Review
   its complete manifest inventory, RBAC, network policies, limits and images.
3. Prepare/qualify the dedicated local reference cluster and build/load the two
   images. Do not rebuild an existing cluster or add a VM as an automatic side
   effect of previewing. Keep kubeconfig private and local.
4. If configuration or image references changed during preparation, generate a
   new preview and review its new approval hash. The reviewed configuration must
   be the configuration you install.
5. Only now open **Organization → Cloud → Compute** and create an enrollment.
   The one-time token expires after ten minutes. Save the enrollment privately;
   never put the token in shell arguments, history, source control or logs.
6. Explicitly run `install:local` with the private input files, chosen context and
   `--approve <reviewed-hash>`. Missing or mismatched approval stops installation.
7. Keep the provisioner running and wait for **Ready** in Compute. A successful
   apply or a running Deployment is not the same as runtime readiness.
8. Select **Use for new workspaces**, then create a new workspace. Existing
   workspaces stay pinned to their original compute target.

## Prepare local files and images

The following preparation does not enroll an installation or change Kubernetes.
Run it from the repository root after the normal repository dependency setup.
Use a new private working directory; do not overwrite an earlier installation's
files or certificate material. If you only want to inspect a preview, stop after
copying/editing the operator file and use `preview:local`; bundle and image
builds are needed before installation, not before preview.

```sh
REPO="$(pwd -P)"
PRIVATE="$REPO/.tmp/onprem-local-setup"
umask 077
mkdir -p "$PRIVATE"
chmod 700 "$PRIVATE"
cp -n services/cloud-agent-next/onprem/operator.local.example.json "$PRIVATE/operator.json"
chmod 600 "$PRIVATE/operator.json"

pnpm -C services/cloud-agent-next run build:wrapper
pnpm -C services/cloud-agent-next/onprem run build
```

The two Dockerfiles consume these bundles; neither builds them automatically.
Use an explicitly verified **local** Docker context, without changing the global
context. Set `LOCAL_DOCKER_CONTEXT` to its name before these commands:

```sh
docker --context "$LOCAL_DOCKER_CONTEXT" buildx build \
  --platform linux/arm64 --provenance=false --load \
  --file services/cloud-agent-next/Dockerfile.onprem \
  --tag kilo-onprem-sandbox:local \
  --metadata-file "$PRIVATE/sandbox-image.json" \
  services/cloud-agent-next

docker --context "$LOCAL_DOCKER_CONTEXT" buildx build \
  --platform linux/arm64 --provenance=false --load \
  --file services/cloud-agent-next/onprem/Dockerfile \
  --tag kilo-onprem-provisioner:local \
  --metadata-file "$PRIVATE/provisioner-image.json" \
  services/cloud-agent-next
```

Both build contexts are `services/cloud-agent-next`. These commands load images
into the local Docker engine and do not push them to a registry. The sandbox
Dockerfile currently supports ARM64 only.

The Docker engine and K3s containerd do **not** share an image store. Before
installation, export the images with `docker image save`, transfer the archives
into the approved no-mount VM, and import them into K3s containerd's `k8s.io`
namespace using the cluster operator's established procedure. Verify both image
references there before starting the installer. An image built on the Mac alone
is not available to a Pod.

For immutable references, use `containerimage.digest` from each Buildx metadata
file and confirm that reference in the node image store. Do not use Docker's
image config `.Id` as the manifest digest. Prefer those digest-pinned references
in the operator file. The example's `:local` tags name the locally built images;
they are not published Kilo images.

### Operator configuration

[`operator.local.example.json`](./operator.local.example.json) is a non-secret
input example, not a ready-to-apply configuration. Edit only your private copy.
Its ports assume the repository's un-offset local services; discover actual
ports with `pnpm dev:status --json` instead of copying them into an offset
worktree unchanged.

| Field | Set it to |
| --- | --- |
| `cloudUrl` | Worker origin reachable from the VM, with the actual Cloud Agent port |
| `cloudIPv4` | IPv4 address tasks use to reach that origin; the example `192.168.5.2` is Lima-specific |
| `upstreams.backendBaseUrl` | Local web/backend origin |
| `upstreams.providerBaseUrl` | Local web model-gateway origin, normally the same as the backend |
| `upstreams.sessionIngestBaseUrl` | Local session-ingest origin |
| `localFixtureUpstreams` | Your local Git and GitHub-API fixture origins; port `18080` is a placeholder and this guide does not start a fixture server |
| `systemNamespace`, `sandboxNamespace` | Distinct, dedicated installation namespaces; do not reuse another installation's namespaces |
| `profile.image`, `provisionerImage` | The image references loaded in the node image store |
| `profile.id`, `profile.revision` | Stable names for the approved local profile and its revision |
| `profile.runtimeClass` | `gvisor` |
| `profile.maxLifetimeMs` | Absolute allocation lifetime cap; the example is one hour |
| `resources` | Task CPU, memory, ephemeral-disk and allocation-concurrency bounds; retain the tested 2048Mi memory setting |
| `instanceTypes` | Optional catalog of named instance types to announce to Cloud Agent; discovery only, not used to size tasks yet |

Each catalog entry has a unique lowercase slug `id` (up to 63 characters), a
`displayName` (up to 100 characters), and `resources` containing `cpuMillis`,
`memoryMiB`, and `diskMiB`. All three quantities are required integers: CPU
100–8000 millicores, memory 256–16384 MiB, and ephemeral storage 512–32768 MiB.
The catalog can contain up to 32 entries; the example declares `small` and
`large`. Concurrency remains installation-wide, not an instance-type property.

The provisioner announces the complete catalog on each authenticated control-plane
exchange. Cloud Agent retains the latest catalog for that installation. An empty
or omitted catalog clears the previous announcement; it does not select a size.
Catalog changes require a new install-preview approval but do not change the
active allocation policy or stop existing sandboxes.

This is discovery groundwork for the pending Cloud Agent instance selector.
Task creation, preflight, LimitRange, ResourceQuota, and concurrency still use
`resources`, regardless of the catalog. Per-task selection, resource application,
and selected-type persistence/recovery will be connected after that PR lands.
An announcement is not proof that every declared size has been runtime-qualified
or that the cluster currently has free capacity for it.

URLs are **origins**, without `/api`, credentials, query or fragment. Use the
actual host address reachable from the VM; `127.0.0.1` inside a Pod is not the
Mac. The example deliberately routes both GitHub hostnames to local fixtures to
avoid accidental requests to real GitHub. Do not remove those mappings merely
to make a local test proceed; a fixture must support the operations being tested.

`dnsIPv4` can be omitted and is then discovered; a supplied value must agree with
cluster DNS. Do not add `profile.brokerUrl`, organization/installation IDs,
`brokerClusterIp`, TLS paths or bootstrap-token paths to this strict operator
object. The installer generates the runtime configuration from operator input,
enrollment and cluster discovery.

## Preview and review before enrollment

After editing the private operator file, run:

```sh
pnpm -C "$REPO/services/cloud-agent-next/onprem" run preview:local \
  --config "$PRIVATE/operator.json" \
  --run-dir "$PRIVATE/review"
```

Open `$PRIVATE/review/install-preview.json` in your editor. Preview reads the
operator configuration and writes only the private review document. It does not
read kubeconfig/enrollment files, contact Kubernetes or the control plane,
generate certificates, start workloads or publish images.

The document contains the complete intended installation: namespaces, identity
Secret, broker Service, namespaced resources and cluster-scoped RBAC. Inspect:

- Names and scopes of namespaces, Roles and bindings, including the named
  ClusterRole/ClusterRoleBinding and SelfSubjectAccessReview permission.
- Which Secrets and ConfigMaps the provisioner can access, and its Pod verbs.
- Image references, network destinations, namespace selectors and resource caps.
- The listed late-bound fields. Enrollment organization/installation IDs,
  discovered DNS/broker IPs and generated certificate/token values are not
  available yet and appear as placeholders, not real credentials.

This is a **review envelope, not a Kubernetes apply file**. Do not pass it to
`kubectl apply`. It is not a diff against live cluster state or proof that the
cluster is compatible; those checks still run during installation.

The document's `approvalHash` identifies the normalized configuration and
rendered manifest preview. Copy it into `APPROVAL_HASH` only after reviewing the
file. If you change an image, namespace, resource limit, destination or installer
manifest definition, generate and review a new preview. The installer recomputes
the hash from current inputs and refuses missing or mismatched approval before
Kubernetes access or installation writes. Editing the saved preview alone does
not change what the installer will apply. The hash binds image references, not
the contents behind mutable registry tags; use digest-pinned image references
for final approval.

Do not automate preview generation and approval as one unchecked command. The
approval hash records your explicit review; it is not a credential, a replacement
for Kubernetes authorization or approval for changes to other cluster resources.

### Enrollment file

Create an enrollment in Compute only after reviewing the final configuration and
manifest preview.
In a private editor, create `$PRIVATE/enrollment.json` with exactly these fields
and replace all placeholders with the values from that enrollment:

```json
{
  "protocolVersion": 1,
  "organizationId": "<organization ID from Compute>",
  "installationId": "<installation ID from Compute>",
  "bootstrapToken": "<one-time token from Compute>",
  "expiresAt": "<exact ISO expiry from Compute>"
}
```

This block is a file shape, not valid enrollment credentials. Preserve the exact
ISO expiry; do not invent a later expiry. The token cannot be recovered after
leaving the page. If it is lost or expired, reconcile/revoke that enrollment
before creating another; do not retry an ambiguous enrollment blindly.

Use an owned, non-symlink kubeconfig for the verified local context. Protect all
three input files, including the operator file, before installation:

```sh
chmod 600 "$PRIVATE/operator.json" "$PRIVATE/enrollment.json" "$PRIVATE/local.kubeconfig"
```

Paths passed to the installer must be absolute. Files must be owned regular
files, without group/other permissions; ancestor directories must not be
symlinks or group/world-writable. The run directory must be private, Git-ignored
and below this checkout's `.tmp/` directory. Keep generated manifests private as
well: some contain bootstrap or TLS material.

## Explicitly install the approved configuration

**This command changes the local cluster and starts the provisioner.** Use
`preview:local` for offline review, not `install:local`. Installation requires
`--approve` with the hash you reviewed; there is no automatic approval or unsafe
bypass. Do not pass the one-time bootstrap token as a command-line argument.

Set `LOCAL_CONTEXT` to the verified context in your private kubeconfig. Its API
server must be an HTTPS origin at `127.0.0.1` or `[::1]`, not `localhost` or a
remote address. TLS bypass, proxy settings, TLS-name overrides and executable
credential/auth-provider plugins are rejected. The installer also requires the
single-node Ubuntu ARM64/K3s/Cilium reference described above.

```sh
pnpm -C "$REPO/services/cloud-agent-next/onprem" run install:local \
  --kubeconfig "$PRIVATE/local.kubeconfig" \
  --context "$LOCAL_CONTEXT" \
  --config "$PRIVATE/operator.json" \
  --enrollment "$PRIVATE/enrollment.json" \
  --run-dir "$PRIVATE/install" \
  --approve "$APPROVAL_HASH"
```

Set `APPROVAL_HASH` to the 64-character lowercase hexadecimal hash you reviewed
in `install-preview.json`. All six flags are required and take separate values;
`--flag=value`, unknown flags and duplicate flags are rejected. `--config` takes
the operator input, not the generated runtime `config.json`. A changed input or
manifest definition requires preview/review again, not an approval bypass.

The installer creates/applies the dedicated namespaces and application
resources, allocates the broker Service, generates private TLS material and
runtime configuration, and starts the provisioner/broker Deployment. It refuses
to take over resources whose ownership labels do not match the enrollment.
`local_install_applied` means the manifests were applied, **not** that the runtime
is ready. Wait for **Ready** in Compute before selecting it for new workspaces.

## Verification and operation

A useful first test is a deterministic agent turn with a real write tool,
a warm read/edit follow-up on the same Pod, and a reverse-terminal command.
The guarded developer harness is
[`test/e2e/onprem.ts`](../test/e2e/onprem.ts); see the
[E2E guide](../test/e2e/README.md) for the surrounding local test workflow.
Use local fixture credentials and services, not production API tokens.

Revocation is not the same as completed physical cleanup. Keep the provisioner
connected after revoking so it can stop owned Pods and report termination.
The installation stays selected while unavailable or revoked; work must fail
closed rather than silently move to another provider. Changing the selected
target affects only new workspaces.

If an existing test installation is revoked, leave it unchanged while preparing
files and images. Reconcile its cleanup before any deliberate fresh enrollment;
do not remove its ledger or replay old failed messages to bypass the revoked
state.

## Current limits

- Images are built from this checkout and loaded locally; no registry publishing
  or remote deployment is part of these instructions.
- The installer does not create cloud accounts, VMs, Kubernetes nodes, gVisor or
  Cilium. It does not configure production upgrades, HA, backups or capacity.
- The anonymous Git test fixture does not create a shared worktree, so sibling
  chat/Stop isolation still needs a separate approved managed-Git fixture.
- A retained test export differed from native Kilo's completion timestamp.
  Later strict transcript checks passed, but that mismatch remains a follow-up.
- Local fake-model and Git tests do not prove live customer integrations,
  arbitrary platforms or production readiness.
