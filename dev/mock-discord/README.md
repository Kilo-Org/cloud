# Mock Discord guild API for the membership row

The Profile screen's Discord row verifies membership by asking the Kilo Discord
server whether the linked account is a member. The check calls the fixed
`https://discord.com/api/v10/guilds/<guildId>/members/<userId>` endpoint, so the
only way to exercise the action without bot credentials is to answer that
endpoint locally. This server does: it holds a leaf certificate for
`discord.com` signed by the mock-snowflake CA the dev stack already trusts, and
answers from a control file.

## Run

```bash
pnpm dev:mock-discord
```

Port `443` is privileged, so run it with `sudo` (`MOCK_DISCORD_PORT` overrides
the port). Two things must hold:

1. `discord.com` resolves to this machine:
   `echo "127.0.0.1 discord.com" | sudo tee -a /etc/hosts`.
2. The web app trusts the dev CA: `pnpm dev:start` exports
   `NODE_EXTRA_CA_CERTS` naming the mock-snowflake bundle, which holds it.

Then set both keys in the root environment file and restart the web app:

```text
DISCORD_OAUTH_BOT_TOKEN=dev-mock-token
DISCORD_SERVER_ID=123456789012345678
```

Any snowflake server id matches the route, and the mock never checks the token.

## Answer

`fixtures/answer.json` holds `{"status": 200}`, `404` or `500`, optionally with a
`body`. The file is re-read on every request, so an answer switches without a
restart; a missing file answers `200`. A status the server does not support is
refused at startup, and an unreadable file answers `500` with the reason, so a
typo shows up instead of a plausible member answer.

| Status | The row shows |
|---|---|
| `200` | the account is a member: the row reports the verification date |
| `404` | the account is not a member: the row offers Verify again |
| `500` | the check failed: the row keeps its last state and reports the failure |

A run under `sudo` hands the certificate and the control file back to the
invoking user, so the file stays editable without `sudo`.

## Fixtures

The linked account and its verification stamp are database facts, so the mock
only answers the check. Put an account in a chosen state with
`pnpm dev:seed app:discord-membership <email> <member|not-member|unlinked>`; it
writes the same `user_auth_provider` row the OAuth link writes.

## Provider behaviour left unproven

The mock stands in for Discord's own guild-member answer. A real bot token, a
real guild, and Discord's rate limits and error bodies are not exercised by it.