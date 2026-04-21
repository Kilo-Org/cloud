/**
 * KiloClaw-mitigated checkIds — false positives on the KiloClaw platform.
 *
 * When a security advisor report originates from a KiloClaw-hosted instance
 * (source.platform === 'kiloclaw'), the following findings are suppressed
 * BEFORE the report is rendered AND BEFORE the grade is computed. They still
 * appear in raw audit data, but the user never sees them and they do not
 * count against the overall score.
 *
 * Why suppress rather than just annotate? Each of these findings is a genuine
 * issue on a generic self-hosted OpenClaw instance — the OpenClaw audit tool
 * detects them correctly. On KiloClaw they are mitigated by infrastructure
 * the audit tool cannot see from inside the gateway process: Fly.io's edge
 * proxy, Fly's private network between edge and gateway, and product design
 * choices that intentionally scope certain settings. The gateway auditor
 * legitimately cannot tell the difference between "unsafe config, exposed to
 * the internet" and "unsafe-looking config, fronted by a managed proxy on a
 * private network." We have that external context and the audit doesn't, so
 * we filter.
 *
 * This repo is public. The rationale for each suppression is documented
 * inline below and surfaced to the end user via a short note in the report
 * ("N findings hidden: mitigated externally by KiloClaw's infrastructure…")
 * so nothing is silently swept under the rug.
 *
 * Keep this list minimal. Only add a checkId here when the mitigation is
 * genuinely external and architectural, not when it's merely inconvenient
 * to explain. A finding that reflects a real operator choice (e.g.
 * `tools.exec.security_full_configured` when someone opts into `full` trust)
 * must stay visible and affect the grade regardless of platform.
 */
export const KILOCLAW_MITIGATED_CHECKS: ReadonlyMap<string, string> = new Map([
  [
    'gateway.trusted_proxies_missing',
    // Gateway is bound loopback-only on KiloClaw. Fly's edge proxy sits at
    // the network boundary in front of the machine, not behind the gateway
    // process. The gateway therefore never receives X-Forwarded-For headers
    // from an external caller — there is no proxy-spoofing path to close.
    // The finding assumes a standard reverse-proxy deployment topology that
    // does not apply.
    'Gateway runs on loopback only; Fly edge terminates at the network boundary, not behind the gateway.',
  ],
  [
    'gateway.control_ui.insecure_auth',
    // `allowInsecureAuth=true` is set when AUTO_APPROVE_DEVICES=true on
    // KiloClaw's provisioning flow. In the KiloClaw deployment model TLS
    // terminates at the Fly edge; the hop between edge and the gateway
    // rides Fly's private network, not the public internet. The credential
    // never crosses an untrusted link, so the "plaintext auth in transit"
    // risk that this check guards against does not exist here.
    "TLS terminates at the Fly edge; the edge-to-gateway hop is on Fly's private network.",
  ],
  [
    'config.insecure_or_dangerous_flags',
    // This is a meta-check that fires because of `allowInsecureAuth` above.
    // On KiloClaw it surfaces the same architectural choice twice in the
    // report. Suppressing it here avoids the duplicate; if a different
    // dangerous flag ever shows up and also happens to be mitigated, that
    // flag's own specific checkId would need its own entry here with its
    // own rationale.
    'Fires because of gateway.control_ui.insecure_auth above; same architectural choice, suppressed to avoid a duplicate finding.',
  ],
  [
    'plugins.tools_reachable_permissive_policy',
    // KiloClaw's product experience (Telegram, Discord, Slack, web-search
    // bots, etc.) intentionally allows plugin-provided tools from the
    // default agent profile — that's how bots invoke their capabilities.
    // Restricting the default profile to block plugin tools would break
    // the core bot workflow. This is a deliberate product design choice,
    // not a misconfiguration.
    'Default profile intentionally reaches plugin tools so bots (Telegram/Discord/Slack/web-search) can invoke their capabilities.',
  ],
  [
    'hooks.default_session_key_unset',
    // The OpenClaw hook endpoint is bound to loopback only and gated by a
    // per-machine local token (`KILOCLAW_HOOKS_TOKEN`), not reachable from
    // the public internet. The only configured hook mapping (inbound email)
    // sets `sessionKey` from the authenticated controller payload, so the
    // unset `defaultSessionKey` fallback that this check guards against is
    // never hit in practice.
    'Hooks bound to loopback and reached only from the KiloClaw controller via a local token; the one configured mapping (inbound email) sets sessionKey from the authenticated payload.',
  ],
  [
    'hooks.allowed_agent_ids_unrestricted',
    // Hooks are loopback-only and gated by a per-machine local token, so
    // there is no authenticated external caller that could name an
    // arbitrary agent id. The KiloClaw controller is the sole caller and
    // invokes a fixed mapping (inbound email) that routes to a fixed agent,
    // never a caller-supplied id — so the wildcard routing this check
    // warns about is not reachable.
    'Hooks bound to loopback; the KiloClaw controller is the only caller and invokes a fixed mapping rather than a caller-supplied agent id.',
  ],
  [
    'fs.config.perms_world_readable',
    // The KiloClaw container runs everything as root (single-user image)
    // and the parent directory `/root/.openclaw` is chmod 0o700 by the
    // controller at boot, so no other user can traverse into the dir
    // regardless of the file's own mode. The controller also now writes
    // openclaw.json with explicit mode 0o600 on every write (see
    // controller/src/atomic-write.ts and config-writer.ts), so fresh or
    // patched configs on new boots are owner-only directly. This
    // suppression covers already-running instances that still have the
    // default-umask 0o644 file on disk from before the chmod fix landed:
    // their threat model is unchanged because of the 0o700 parent dir,
    // and the file will be tightened the next time anything writes it.
    'Container runs single-user as root, parent dir /root/.openclaw is 0o700, and the controller now writes openclaw.json with explicit 0o600 mode — file perms are architecturally moot here.',
  ],
]);

/**
 * True if `checkId` is in the KiloClaw-mitigated list. The caller is
 * responsible for only invoking this when the scan actually originated
 * from a KiloClaw-hosted instance — the same findings are real issues on
 * self-hosted OpenClaw and must NOT be filtered there.
 */
export function isKiloClawMitigated(checkId: string): boolean {
  return KILOCLAW_MITIGATED_CHECKS.has(checkId);
}
