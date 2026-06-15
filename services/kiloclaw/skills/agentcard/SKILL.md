---
name: agentcard
description: Create and manage virtual debit cards with AgentCard. Use when the user wants to create a card, check a card balance, review card transactions, or close a card.
---

# AgentCard

AgentCard issues virtual debit cards. Use this skill whenever the user wants to
create a card, fund a purchase, check a balance, review transactions, or close a
card.

AgentCard runs as the `agentcard` MCP server, reached through your `mcporter` skill.
Call its tools with:

```bash
mcporter call agentcard.<tool> <arg>:<value>
```

## First: discover the live tools and their exact arguments

Tool arguments can change, so introspect rather than guess:

```bash
mcporter list agentcard                      # list available tools
mcporter call agentcard.<tool> --schema      # see one tool's exact parameters
```

## Common operations

- **Create a card** — `create_card` requires `amount_cents` (an integer; e.g. `2000`
  for a $20 card):
  ```bash
  mcporter call agentcard.create_card amount_cents:2000
  ```
- **List cards** — `mcporter call agentcard.list_cards`
- **Card details** (PAN / expiry / CVC) — `mcporter call agentcard.get_card_details card_id:<id>`
- **Check balance** — `mcporter call agentcard.check_balance card_id:<id>`
- **List transactions** — `mcporter call agentcard.list_transactions card_id:<id>`
- **Close a card** — `mcporter call agentcard.close_card card_id:<id>`

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
