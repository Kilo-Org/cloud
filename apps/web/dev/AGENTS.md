# Dev Script Guide For AI Agents

These webhook test scripts intentionally use generic placeholder JSON.
They are not expected to represent valid production payloads.
Preferred workflow: capture a real webhook from smee.io, then ask an AI to replace or provide that payload to the script.

## Script Map

- Review flow:
  - `./dev/review/dev-review.sh`
  - `./dev/review/test-review-webhook.sh [payload.json]`
- Auto-fix flow (`@kilo fix it`):
  - `./dev/auto-fix/dev-auto-fix.sh`
  - `./dev/auto-fix/test-auto-fix-webhook.sh [payload.json]`

## GitHub App Install Prerequisites

1. Ensure local app secrets are configured, especially `GITHUB_APP_WEBHOOK_SECRET` in `.env.local`.
2. Install the GitHub App on the repo/org you want to test.
3. In the GitHub App webhook settings:

- Set webhook URL to your smee channel URL: `https://smee.io/<channel-id>`.
- Set webhook secret to match your local webhook secret.
- Subscribe to required events:
- Review flow: `pull_request`.
- Auto-fix flow: `pull_request_review_comment`.

## Forward GitHub Events Locally With smee.io

1. Create a channel at [smee.io](https://smee.io).
2. Run the relay locally:

```bash
npx smee-client \
  --url https://smee.io/<channel-id> \
  --target http://127.0.0.1:3000/api/webhooks/github
```

3. Keep this process running while testing.
4. Trigger a real GitHub event and capture the delivered JSON payload from smee.

## How AI Agents Should Use The Test Scripts

1. Start the required local services using the matching `dev` script.
2. Save the real captured webhook payload to a JSON file.
3. Run the matching test script with that file path.
4. If payload is wrapped as `{"event":"...","payload":{...}}`, scripts auto-unwrap `.payload`.
5. If no file is provided, scripts send embedded generic placeholder JSON.

## Notes

- Generic payload mode is for scaffolding only and may fail validation or integration checks.
- Real payloads from smee are the source of truth for local webhook debugging.
- Scripts sign payloads using `WEBHOOK_SECRET` (env override supported).
- Log files are written under:
- `dev/.dev-logs/review/` for review flow
- `dev/.dev-logs/auto-fix/` for auto-fix flow
