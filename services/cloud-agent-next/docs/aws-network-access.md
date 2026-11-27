# AWS network access

AWS sandboxes send network traffic through a proxy in your AWS account.
The proxy forwards general traffic directly to public destinations. Managed Git and SCM API traffic uses Kilo's credential broker.

Use HTTPS on port 443. Plain `http://` requests fail, even with unrestricted network access.
Tools must use the configured proxy. Direct connections fail.

With an allowlist, the proxy checks the destination hostname declared when a tool opens a CONNECT tunnel.
It also checks the resolved public address. It does not inspect the encrypted traffic inside an ordinary tunnel.
The inner TLS server name and HTTP Host can differ from the declared hostname on shared CDN infrastructure.
Allowing a hostname therefore does not guarantee that every request inside the tunnel uses that hostname.
Managed SCM connections receive separate destination and credential checks.

When auditing is enabled, one connection record reports one tunnel decision, its hostname and port.
The record has `scope: connection`; its `CONNECT` method describes the proxy operation.
A tunnel can carry many requests. The record does not report their count or inner HTTP methods.
Intercepted SCM requests have separate records with `scope: request` and their actual method.
Historical records without scope do not identify their audit level.
Audit records contain no URL paths, query values, headers or bodies.
