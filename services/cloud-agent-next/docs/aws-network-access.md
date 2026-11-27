# AWS network access

The EC2 host sends workspace HTTP and TLS traffic through its proxy. Tools use their normal HTTP
and HTTPS clients. For HTTP, the proxy checks the destination address and HTTP Host. For TLS,
the proxy checks the server name in the ClientHello and the destination address. The proxy limits
connections to public addresses. When an allowlist applies, the requested name must match it.

Managed Git and supported SCM API requests use Kilo's credential broker. The proxy checks the
request destination before forwarding it. The broker authorizes the current repository grant.

Audit records contain the destination and the admission outcome. TLS connection records describe
one connection. Intercepted HTTP request records report the HTTP method. Audit records omit URL
paths, query values, headers, and bodies.
