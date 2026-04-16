CREATE TABLE "security_advisor_check_catalog" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"check_id" text NOT NULL,
	"severity" text NOT NULL,
	"explanation" text NOT NULL,
	"risk" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_advisor_check_catalog_check_id_unique" UNIQUE("check_id"),
	CONSTRAINT "security_advisor_check_catalog_severity_check" CHECK ("security_advisor_check_catalog"."severity" in ('critical', 'warn', 'info'))
);
--> statement-breakpoint
CREATE TABLE "security_advisor_content" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_advisor_content_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "security_advisor_kiloclaw_coverage" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"area" text NOT NULL,
	"summary" text NOT NULL,
	"detail" text NOT NULL,
	"match_check_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_advisor_kiloclaw_coverage_area_unique" UNIQUE("area")
);
--> statement-breakpoint
-- Seed: check catalog (backfill of previously-hardcoded per-checkId content)
INSERT INTO "security_advisor_check_catalog" ("check_id", "severity", "explanation", "risk") VALUES
('fs.config.perms_world_readable', 'critical',
 'The OpenClaw configuration file is readable by all users on the system. This file typically contains API keys, auth tokens, and other secrets.',
 'Any process or user on this machine can read your secrets. A compromised or malicious process gains immediate access to all stored credentials.'),
('fs.config.perms_group_readable', 'warn',
 'The OpenClaw configuration file is readable by users in the same group. This may expose secrets to other services running under the same group.',
 'Other processes sharing the group can read stored credentials. This is especially risky on shared hosting or multi-tenant servers.'),
('auth.no_authentication', 'critical',
 'The OpenClaw instance has no authentication configured. Anyone who can reach the gateway can use it without credentials.',
 'Unauthorized users can execute commands, access conversations, and consume API credits. This is the highest risk configuration for an internet exposed instance.'),
('net.gateway_exposed', 'warn',
 'The OpenClaw gateway is bound to a non localhost address, making it reachable from the network.',
 'Network adjacent attackers can connect directly to the gateway. Combined with weak or no authentication, this enables unauthorized access.'),
('net.gateway_open_to_world', 'critical',
 'The OpenClaw gateway is bound to 0.0.0.0, accepting connections from any IP address.',
 'The instance is accessible from the entire internet. Without proper authentication and allow listing, this exposes the instance to brute force attacks, credential stuffing, and abuse.'),
('net.no_tls', 'warn',
 'Traffic to the OpenClaw gateway is not encrypted with TLS.',
 'API keys, auth tokens, and conversation content are transmitted in plaintext. Anyone on the network path can intercept and read this traffic.'),
('net.no_allowlist', 'warn',
 'No IP allow list is configured. The gateway accepts connections from any source IP.',
 'There is no network layer restriction on who can attempt to connect. Authentication is the only barrier to unauthorized access.'),
('secrets.plaintext_in_config', 'critical',
 'API keys or secrets are stored in plaintext in the configuration file.',
 'If the config file is compromised (via file permission issues, backup exposure, or accidental commit), all secrets are immediately usable by an attacker.'),
('version.outdated', 'warn',
 'The OpenClaw version is behind the latest release.',
 'Older versions may contain known security vulnerabilities that have been patched in newer releases. Running outdated software increases exposure to known exploits.'),
('summary.attack_surface', 'info',
 'This is a summary of the overall attack surface — network exposure, open ports, and access controls in aggregate.',
 'A larger attack surface means more potential entry points for attackers.')
ON CONFLICT ("check_id") DO NOTHING;
--> statement-breakpoint
-- Seed: KiloClaw coverage (backfill of previously-hardcoded KILOCLAW_COMPARISON)
INSERT INTO "security_advisor_kiloclaw_coverage" ("area", "summary", "detail", "match_check_ids") VALUES
('config_permissions',
 'Config files are restricted to owner only access',
 'KiloClaw instances are provisioned with strict file permissions. The OpenClaw config file and all credential material are owned by a dedicated service user. No other process on the instance can read secrets from the config.',
 ARRAY['fs.config.perms_world_readable', 'fs.config.perms_group_readable']::text[]),
('authentication',
 'JWT + pepper auth on every request with automatic rotation',
 'KiloClaw enforces JWT based authentication on every API request. Tokens are scoped per user, short lived for session use, and long lived tokens (device auth) are peppered and stored encrypted. Token validation happens at the gateway layer before any request reaches the OpenClaw process.',
 ARRAY['auth.no_authentication', 'auth.weak_token', 'auth.token_exposed', 'auth.no_pepper']::text[]),
('gateway_exposure',
 'Gateway bound to localhost; external access via authenticated reverse proxy only',
 'KiloClaw instances run behind an authenticated reverse proxy. The OpenClaw gateway is never directly exposed to the internet. All external traffic is routed through the platform load balancer with TLS termination, rate limiting, and DDoS protection.',
 ARRAY['net.gateway_exposed', 'net.gateway_open_to_world', 'net.no_tls', 'summary.attack_surface']::text[]),
('secret_storage',
 'Secrets injected via encrypted environment variables, never stored on disk',
 'API keys and credentials on KiloClaw are injected as encrypted environment variables at boot time, sourced from a secrets manager. They are never written to the config file or any on disk location. The OpenClaw process reads them from memory only.',
 ARRAY['secrets.plaintext_in_config', 'secrets.api_key_exposed', 'secrets.env_file_readable']::text[]),
('network_allowlist',
 'Strict IP allow listing with default deny firewall rules',
 'KiloClaw instances use a default deny firewall. Only explicitly allowed IP ranges can reach the gateway. The allow list is managed per organization through the KiloClaw dashboard and enforced at the network layer, not just the application layer.',
 ARRAY['net.no_allowlist', 'net.allowlist_too_broad', 'net.open_to_all']::text[]),
('update_policy',
 'Security patches released quickly with proactive update alerts',
 'KiloClaw instances receive automatic security patches.',
 ARRAY['version.outdated', 'version.unsupported', 'version.cve_known', 'plugins.outdated']::text[]),
('audit_logging',
 'Full request audit trail with 90 day retention',
 'Every API request to a KiloClaw instance is logged with timestamp, user ID, action, and result.',
 ARRAY['audit.no_logging', 'audit.logs_world_readable', 'audit.no_retention']::text[])
ON CONFLICT ("area") DO NOTHING;
--> statement-breakpoint
-- Seed: editable marketing copy (CTA, framing templates, fallback text).
-- Structural chrome (section headings, labels, summary-line formats) is kept
-- inline in report-generator.ts — those are formatting, not content, and
-- cluttered the admin UI without being anything a non-engineer would edit.
INSERT INTO "security_advisor_content" ("key", "value", "description") VALUES
('section.next_step', '## Next step: try KiloClaw free', 'CTA section heading for non-KiloClaw users. Paired with cta.body.'),
('cta.body',
 '**Want these issues handled automatically?** KiloClaw manages security configuration, patching, and monitoring out of the box. **Start a free trial at [kilo.ai/kiloclaw](https://kilo.ai/kiloclaw).**',
 'CTA body paragraph shown to OpenClaw users at the bottom of the report.'),
('framing.openclaw',
 '**How KiloClaw handles this:** {summary}. {detail}',
 'Template for the KiloClaw coverage shown to OpenClaw users. Placeholders: {summary}, {detail}.'),
('framing.kiloclaw',
 '**KiloClaw default:** {summary}. Your instance has diverged from this default configuration. This may indicate a manual change or misconfiguration that should be reviewed.',
 'Template for the divergence warning shown to KiloClaw users. Placeholder: {summary}.'),
('fallback.risk',
 'Your OpenClaw instance reports this finding and should be reviewed: {detail}',
 'Fallback risk statement used when a finding''s checkId has no catalog entry. Placeholder: {detail}.'),
('fallback.recommendation_action',
 'Address finding: {title} ({checkId})',
 'Fallback recommendation action when a finding has no fix. Placeholders: {title}, {checkId}.')
ON CONFLICT ("key") DO NOTHING;
