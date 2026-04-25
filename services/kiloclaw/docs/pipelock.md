# Pipelock Sidecar (Optional)

KiloClaw VMs can optionally run [Pipelock](https://github.com/luckyPipewrench/pipelock), an agent firewall that sits between the OpenClaw process and the network. When enabled, covered outbound HTTP(S) traffic from the agent is scanned for secret exfiltration, prompt injection, SSRF, and tool-policy violations before leaving the VM.

This document covers the V1 controller-side integration. Worker-side per-customer enablement is a separate follow-up owned by Kilo.

## What pipelock does

| Traffic path                                                                  | Scanning                                                           | Action                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------ |
| HTTPS LLM chat completions (Anthropic, OpenAI, Kilo Gateway)                  | Per-SSE-event DLP + prompt-injection while preserving streaming UX | Configurable (`block` default) |
| HTTPS web fetches (tools, MCP over HTTP, shell `curl`, etc.)                  | Full-body DLP + injection + SSRF                                   | Configurable (`block` default) |
| HTTP CONNECT to blocklisted domains (known paste sites, exfil infrastructure) | Connection refused                                                 | `block`                        |
| Outbound requests matching DLP rules (API keys, tokens, credentials, PII)     | Logged and blocked before leaving the VM                           | `block`                        |

Pipelock runs as a local-only forward proxy on `127.0.0.1:8888`. The OpenClaw child process has `HTTPS_PROXY` and friends set in its environment, so HTTP/HTTPS traffic issued through env-aware clients routes through the proxy. The controller smoke test for this PR should verify the baked OpenClaw version's own `fetch()` path and common shell-outs (`curl`, `git`, `npm`, `pip`) hit Pipelock before treating the integration as production-ready.

### Enforcement boundary (read this before treating V1 as airtight)

V1 enforcement is **application-level**, not VM-level. Outbound traffic is routed through Pipelock by virtue of the OpenClaw child's environment, which is a cooperative contract:

- **Covered:** OpenClaw HTTP calls and shell-outs that honor `HTTPS_PROXY`/`HTTP_PROXY`, including env-aware CLI tools such as curl, git, npm, and pip.
- **Not covered:** code paths that explicitly bypass proxy env vars, raw socket usage (`net.connect()` direct), tools that ignore proxy env (some Go binaries with their own dispatchers), and any process that unsets `HTTPS_PROXY` before connecting.

For airtight enforcement, the recommended follow-up is **VM-level egress containment** outside the scope of this PR:

- Run OpenClaw under a separate UID with iptables `OWNER` match rules: only the `pipelock` UID may reach external networks; the OpenClaw UID may reach `127.0.0.1:8888` and nothing else.
- Or run OpenClaw inside a network namespace with a single veth pair to the Pipelock netns.
- Or restrict outbound at the Fly Machine level via firewall rules.

V1 ships the proxy + cooperative env injection because it captures the high-value traffic (LLM API calls, web fetches, MCP HTTP) without infrastructure-level changes to KiloClaw. Operators who need strict enforcement should layer one of the above mechanisms on top.

## Enabling pipelock

Set `KILOCLAW_PIPELOCK_ENABLED=1` in the instance's environment. Accepted truthy values are `1`, `true`, `yes`, and `on` (case-insensitive). Anything else (including unset, empty, or `0`) disables the integration.

When enabled, the controller performs these steps during startup (Phase 7, before OpenClaw starts):

1. **Ensure the per-VM CA exists.** If `/root/.pipelock/ca.pem` and `/root/.pipelock/ca-key.pem` do not already exist, the controller runs `pipelock tls init` to generate them. The private key is written at mode `0o600`. The CA lives on the Fly Volume so it persists across machine restarts; it is never baked into the image.
2. **Build a combined CA bundle.** `/root/.pipelock/ca-bundle.pem` combines Debian's system trust bundle with the per-VM Pipelock CA. If the instance env already pre-sets `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, or similar, those customer bundles are also concatenated into the combined file so the customer's pre-existing trust roots survive when the agent child env points the same vars at our combined bundle. Node receives the Pipelock CA through `NODE_EXTRA_CA_CERTS`; tools that replace their trust bundle receive the combined file. Customer-set `NO_PROXY` entries are similarly preserved by appending our loopback bypass list to whatever was already there.
3. **Write the managed Pipelock config.** `/etc/pipelock/config.yaml` is written atomically at mode `0o600`. The config is regenerated on every boot to match the controller's expected template (see [`controller/src/pipelock.ts`](../controller/src/pipelock.ts) for the source of truth).
4. **Start the Pipelock supervisor.** `pipelock run --config /etc/pipelock/config.yaml` is launched under the existing process supervisor. The sidecar runs with an explicit, secret-free environment (allowlist of `PATH`, `HOME`, locale, and tempdir vars only). Decrypted agent credentials and proxy env vars are deliberately stripped: capability separation means the sidecar should never see the agent's API keys, gateway tokens, or channel secrets, and stripping `HTTPS_PROXY` prevents the proxy from looping through itself.
5. **Wait for spawn, then for readiness.** Two phases:
   - **Spawn check (~2s):** the controller polls Pipelock's supervisor state. If the binary is missing or non-executable (`ENOENT` / `EPERM`), the supervisor reports `crashed` immediately and the controller surfaces this as `pipelock-start` rather than waiting out the full readiness ceiling.
   - **Readiness check (30s):** the controller polls `http://127.0.0.1:8888/health` and requires `status=healthy`, `forward_proxy_enabled=true`, `tls_interception_enabled=true`, `response_scan_enabled=true`, and `kill_switch_active` not equal to true. The kill-switch check refuses to mark KiloClaw ready when an operator has pre-activated the proxy's deny-all switch; surfacing a clear `pipelock-listen` is better than starting OpenClaw into a 100%-blocked proxy.
     If either check fails, the controller enters degraded mode and never starts OpenClaw (see Fail-closed below).
6. **Start OpenClaw with proxy env.** The gateway child receives:

   | Variable                      | Value                           |
   | ----------------------------- | ------------------------------- |
   | `HTTPS_PROXY` / `https_proxy` | `http://127.0.0.1:8888`         |
   | `HTTP_PROXY` / `http_proxy`   | `http://127.0.0.1:8888`         |
   | `NO_PROXY` / `no_proxy`       | `127.0.0.1,localhost,::1`       |
   | `NODE_EXTRA_CA_CERTS`         | `/root/.pipelock/ca.pem`        |
   | `SSL_CERT_FILE`               | `/root/.pipelock/ca-bundle.pem` |
   | `REQUESTS_CA_BUNDLE`          | `/root/.pipelock/ca-bundle.pem` |
   | `CURL_CA_BUNDLE`              | `/root/.pipelock/ca-bundle.pem` |
   | `GIT_SSL_CAINFO`              | `/root/.pipelock/ca-bundle.pem` |
   | `NPM_CONFIG_CAFILE`           | `/root/.pipelock/ca-bundle.pem` |
   | `PIP_CERT`                    | `/root/.pipelock/ca-bundle.pem` |

> Note: V1 ships the controller-side integration only. The Cloudflare Worker side (where `KILOCLAW_PIPELOCK_ENABLED` is threaded into a specific instance's `runtimeSpec.env`) is a Kilo-owned follow-up. Until that lands, the flag can be enabled globally via the Worker's shared env for evaluation.

## Disabling pipelock

Remove or unset `KILOCLAW_PIPELOCK_ENABLED`. On the next VM start, the controller follows the unchanged pre-pipelock path: no sidecar, no proxy env injection, byte-identical OpenClaw configuration. Existing VMs are not affected unless they restart with the flag set.

## Fail-closed behavior

If the flag is set but Pipelock cannot start, the controller **stays in degraded mode and does NOT start OpenClaw**. Running the agent unproxied when the operator asked for scanning would silently undo the security model.

Three degraded states are possible:

| Stage             | Meaning                                                                                                   | `/health` error                         |
| ----------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `pipelock-init`   | CA generation, CA bundle write, or config write failed                                                    | `Startup failed during pipelock-init`   |
| `pipelock-start`  | `pipelock` binary missing, non-executable, or crashed during spawn                                        | `Startup failed during pipelock-start`  |
| `pipelock-listen` | Pipelock spawned but did not report a fully healthy proxy within 30s, OR the kill switch is pre-activated | `Startup failed during pipelock-listen` |

The HTTP server stays up so health probes and admin routes remain reachable for diagnosis. The full error is logged to stdout on the VM; the public `/health` response only returns the stage name.

## Troubleshooting

### Inspect pipelock logs

Pipelock writes scanner verdicts and audit events to stderr, and the supervisor forwards child stdout/stderr into the controller logs. View them alongside the controller log:

```bash
fly logs -a <app-name>
# or, on the machine:
journalctl -u kiloclaw-controller
```

### Verify the sidecar is listening

```bash
fly ssh console -a <app-name> -C 'ss -ltnp | grep 8888'
# Expected: LISTEN on 127.0.0.1:8888 held by a `pipelock` PID
```

### Verify the health contract

```bash
fly ssh console -a <app-name> -C 'curl -fsS http://127.0.0.1:8888/health'
```

The response should include `"status":"healthy"`, `"forward_proxy_enabled":true`, `"tls_interception_enabled":true`, and `"response_scan_enabled":true`.

### Inspect the generated config

```bash
fly ssh console -a <app-name> -C 'cat /etc/pipelock/config.yaml'
```

The file is managed by the controller. Edits made by hand are overwritten on the next VM boot.

### Verify the CA was generated

```bash
fly ssh console -a <app-name> -C 'ls -la /root/.pipelock/'
# Expected:
#   -rw-------  ca-key.pem     (mode 0o600, never world-readable)
#   -rw-r--r--  ca.pem         (public CA cert)
#   -rw-r--r--  ca-bundle.pem  (system roots + public CA cert)
```

### Confirm OpenClaw is actually using the proxy

Inside the VM:

```bash
# From the OpenClaw child's perspective, every fetch should route through 127.0.0.1:8888.
# A quick smoke test:
curl -v -x http://127.0.0.1:8888 --cacert /root/.pipelock/ca.pem https://example.com 2>&1 | grep -E '(CONNECT|HTTP/)'
```

If you see `CONNECT example.com:443` in the output, traffic is flowing through Pipelock.

## Not in V1

- Per-instance UI toggle on the KiloClaw dashboard
- Per-instance custom DLP rules or tool-policy edits
- Billing integration
- Signed action receipts surfaced to the customer
- Worker-side per-instance enablement plumbing (Kilo-owned follow-up)
- VM-level egress enforcement (iptables `OWNER` match, network namespace split, or Fly-level firewall), strongly recommended as a follow-up if the threat model includes a malicious or compromised OpenClaw process actively trying to bypass the proxy

## Further reading

- Pipelock project: https://github.com/luckyPipewrench/pipelock
- Pipelock security posture: https://pipelab.org/security.html
- Controller-side integration source: [`controller/src/pipelock.ts`](../controller/src/pipelock.ts)
