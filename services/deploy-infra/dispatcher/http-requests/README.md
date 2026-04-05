# Dispatcher HTTP Requests

HTTP request collection for testing the Dispatcher API using [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) for VSCode.

## Quick Start

1. Install [REST Client extension](https://marketplace.visualstudio.com/items?itemName=humao.rest-client)
2. Copy `.env.example` to `.env` and fill in your auth tokens
3. Open [`dispatcher.http`](./dispatcher.http)
4. Uncomment the environment block you want to use (local/staging/production)
5. Click "Send Request" above any request

## Managing Credentials

```bash
cp .env.example .env
# Edit .env with your actual tokens
```

The `.env` file is gitignored so your credentials won't be committed.

## Files

| File              | Purpose                              |
| ----------------- | ------------------------------------ |
| `dispatcher.http` | All API requests (management + auth) |
| `.env.example`    | Template for credentials             |
| `.env`            | Your credentials (gitignored)        |
