---
name: weather
description: Use wttr.in to answer weather questions for the user's saved location.
---

# Weather

Use this skill when the user asks about current weather, forecasts, conditions, sunrise/sunset, or what to wear outside.

## Default Location

- Read `/root/.openclaw/workspace/USER.md` and use the `Location` field as the default weather location.
- If the user asks about a different place, use the location from their request instead.
- Do not expose raw coordinates. Prefer human-readable places from `USER.md` or the user's message.

## wttr.in Commands

Use `curl` with wttr.in for weather data:

- Compact current conditions: `curl -s 'https://wttr.in/<location>?format=3'`
- Forecast text: `curl -s 'https://wttr.in/<location>?n&Q'`
- JSON for structured details: `curl -s 'https://wttr.in/<location>?format=j1'`

Encode spaces as `+` or `%20` in URLs. Keep answers concise and practical, and include units shown by wttr.in.
