---
name: agentcard
description: Create and manage virtual debit cards with AgentCard — issue and close cards, check balances and transactions, manage plan, payment methods, and account, and contact support. Use whenever the user wants to create or spend a virtual card, fund a purchase, or manage their AgentCard account.
---

# AgentCard

AgentCard issues virtual debit cards for agent spending. Use this skill whenever
the user wants to create or close a card, fund a purchase, check a balance or
transactions, manage their plan or payment methods, or contact AgentCard support.

AgentCard runs as the `agentcard` MCP server, reached through your `mcporter` skill.
Call its tools with:

```bash
mcporter call agentcard.<tool> <arg>:<value>
```

## First: discover the live tools and their exact arguments

The tool set and arguments can change, so introspect rather than guess:

```bash
mcporter list agentcard                      # list available tools
mcporter call agentcard.<tool> --schema      # see one tool's exact parameters
```

## Available tools

### Cards
- **`list_cards`** — List all virtual cards with IDs, last four, expiry, balance,
  and status. Start here to find a card.
- **`create_card`** — Create a new virtual debit card. Takes `amount_cents` (integer,
  min 100; e.g. `2000` = $20). New accounts default to test mode. Limits depend on the
  plan — see `get_plan`.
- **`check_balance`** — Live balance for a card. Prefer this over `get_card_details`
  when you only need funds (faster, no sensitive credentials).
- **`get_card_details`** — Decrypted PAN, CVV, expiry, and balance for a card. Use
  only to fill a payment form. May require human approval — if it returns a 202,
  prompt the user and then call `approve_request`.
- **`list_transactions`** — Transactions for a card (amount, merchant, status,
  timestamps); supports `limit`/`status` filters.
- **`close_card`** — Permanently close a card. Irreversible; idempotent.

### Approvals
- **`approve_request`** — Resolve a pending approval (approve/deny). Use after
  `get_card_details` or `create_card` returns a 202 requiring approval; on approval it
  automatically completes the follow-up action.

### Account & onboarding
- **`submit_user_info`** — Submit phone number + terms acceptance required before the
  first card. Call after `create_card` returns a `user_info_required` response. (Name
  and DOB are collected automatically during KYC.)
- **`get_mode`** — Get the current issuing mode (`test` vs `prod`).
- **`set_mode`** — Switch issuing mode. `mode:prod` issues live cards funded by the
  saved payment method (real charges); `mode:test` issues sandbox cards. Confirm with
  the user before switching to `prod`.

### Plan & billing
- **`get_plan`** — Current plan, per-card cap, monthly card limit, and usage. Call
  before `create_card` when you need the cap or remaining quota.
- **`upgrade_plan`** — Start an upgrade to the Basic plan ($15/mo); returns a Stripe
  Checkout URL the user opens to pay. Use only when the user explicitly wants to upgrade.
- **`cancel_plan`** — Cancel the active paid subscription, reverting to free.

### Payment methods
- **`list_payment_methods`** — Saved methods used to fund card creation (id, brand,
  last 4, expiry, default).
- **`setup_payment_method`** — Add a payment method; returns a secure checkout URL the
  user must open.
- **`set_default_payment_method`** — Set which saved method funds new cards
  (`payment_method_id`).
- **`remove_payment_method`** — Detach a saved method permanently (`payment_method_id`).

### Connections
- **`list_connections`** — Third-party apps (e.g. Kilo) connected to the user's
  AgentCard account via OAuth, with connected-at and active status. Read-only — to
  revoke, the user runs `agent-cards connections revoke <clientId>` in the CLI.

### Support
- **`start_support_chat`** — Start a support conversation and send the first message.
- **`send_support_message`** — Send a message in an existing support conversation.
- **`read_support_chat`** — Read a support conversation's message history.

### Browser checkout (requires the AgentCard Pay Chrome extension)
These automate paying on a real checkout page and need Chrome with the AgentCard Pay
extension — **not available in the headless agent**, so they typically won't work here.
Prefer `create_card` + `get_card_details` and fill the form yourself.
- **`detect_checkout`** — Check whether the current browser tab is a checkout page.
- **`pay_checkout`** — Create/reuse a card and auto-fill a checkout page.
- **`fill_card`** — Fill an existing card into the current checkout form.

## Common operations

```bash
mcporter call agentcard.create_card amount_cents:2000     # $20 card
mcporter call agentcard.list_cards
mcporter call agentcard.check_balance card_id:<id>
mcporter call agentcard.get_card_details card_id:<id>     # PAN/CVC/expiry (may need approval)
mcporter call agentcard.list_transactions card_id:<id>
mcporter call agentcard.close_card card_id:<id>
```

## Test mode vs production

New AgentCard accounts start in **TEST mode**: cards are sandbox-funded, incur no
real charges, and won't work at real merchants. After creating a card, check whether
the result says it's a TEST card and, if so, tell the user they're in test mode.

- Check the current mode: `mcporter call agentcard.get_mode`
- Switch to live cards: `mcporter call agentcard.set_mode mode:prod` — **confirm with
  the user first**, since prod cards are charged to their real payment method.

## If AgentCard isn't connected

If `mcporter list agentcard` reports the server is unavailable (no `agentcard`
server configured), the user hasn't connected their account yet. Tell them to connect
it in **Settings → Payments → Connect Agentcard** — it's a one-click OAuth step, with
nothing to install. Once connected, the `agentcard` tools become available
automatically.
