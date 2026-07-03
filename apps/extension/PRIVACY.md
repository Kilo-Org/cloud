# Kilo Code Browser Extension — Privacy Policy

**Last updated:** July 3, 2026

This policy describes what data the Kilo Code browser extension ("the extension") collects, accesses, stores, and transmits. It covers both the Chrome and Firefox versions, which share identical functionality and codebase. The extension is a side-panel AI chat agent that can, at the user's direction, read and act on the content of the browser tab the user selects.

This policy describes the extension's own behavior. It does not describe how the Kilo Code cloud service (`app.kilo.ai`) processes data server-side once received — see the main [Kilo Code Privacy Policy](https://kilo.ai/privacy) for that.

## Summary of what this extension does

The extension has no content scripts and injects no code into web pages automatically. Nothing is read from a page, and nothing leaves your device, unless you open the side panel and interact with the agent (for example, by asking it to look at the current tab, take a screenshot, or run a command in the page). All data described below is either (a) required to authenticate you to your Kilo Code account, (b) explicitly requested by you through a tool the AI agent uses on your active tab, or (c) configuration you enter yourself (e.g., a remote MCP server address).

## Data we access or collect, and how it is used

### 1. Kilo Code account authentication token
- **What:** An opaque bearer token obtained via a device-code sign-in flow with `app.kilo.ai` (or a locally configured Kilo backend during development), and the Google account email address associated with your Kilo Code account (returned by the account backend after sign-in).
- **How obtained:** You initiate sign-in from the side panel; the extension polls `app.kilo.ai` until the flow completes.
- **Where stored:** `chrome.storage.local` (browser-local storage, not synced across devices), unencrypted.
- **Where it goes:** Sent as an `Authorization: Bearer <token>` header on every request the extension makes to the Kilo Code backend (account info, model list, organization list, chat completions).
- **Not collected:** Your Kilo Code account password is never seen or stored by the extension; sign-in uses a token exchange.

### 2. Organization / credit account selection
- **What:** The ID of the organization or credit account you select in the side panel (if your account belongs to more than one).
- **Where stored:** `chrome.storage.local`.
- **Where it goes:** Sent as an `x-kilocode-organizationid` request header on gateway/model API calls to `app.kilo.ai`, so requests are billed/scoped to the right organization.

### 3. Content of the browser tab you select, but only when you invoke a tool
The extension does not run on every page you visit and has no background page-scraping. Tab/page data is only read at the moment you (or the AI agent acting on your explicit instruction) invoke one of the following tools against the tab you have selected in the side panel:
- **List of open tabs** (title and URL of each open `http(s)`/`file` tab), used to let you pick which tab the agent should work with. Read via the browser's tabs/debugging APIs; kept in memory only, not persisted to storage on its own.
- **Page snapshot** — visible text, headings, links, and form control state from the selected page's DOM, capped in size and with query strings/URL fragments stripped. Obtained by briefly running a script inside the page (via the browser's scripting/debugging APIs).
- **Selected tab's title, sanitized URL (no query string/fragment), current time, and your local timezone** — attached to your messages as hidden context so the AI model knows what page you're referring to.
- **Viewport screenshot** of the selected tab (as a PNG image), taken only when the agent's screenshot tool is used, and only sent to a vision-capable model when relevant.
- **Result of a JavaScript expression** the AI model authors and runs in the selected tab. This is only available in "dangerous mode" (an explicit, user-enabled setting) and can, like any script you'd paste into DevTools yourself, read or modify whatever the page's own script context can access. The extension's tools do not read cookies or browser history and do not perform automatic form-filling or navigation outside of what the model's authored script does when you've enabled dangerous mode.

All of the above (except the raw screenshot image data, see below) is stored in the extension's local conversation history (`chrome.storage.local`) so you can resume a chat, and is sent to the Kilo Code chat/completions API (`app.kilo.ai`, or your configured local endpoint) as context for the AI model to answer your request. Screenshot image data is sent to the completions API when used but is **deliberately stripped before being saved** to local conversation history — only a placeholder noting the screenshot was omitted is retained.

### 4. Conversation content
- **What:** Your messages, the AI's responses and "thinking" text, tool calls and tool results, the conversation title, and settings like which model and safe/dangerous mode you had selected.
- **Where stored:** `chrome.storage.local`, so you can close and reopen the side panel without losing your conversation.
- **Where it goes:** The full conversation is sent to the Kilo Code chat completions API (`app.kilo.ai`) each time you send a message, so the AI model has the context needed to respond. Responses stream back over the same connection.

### 5. Remote MCP (Model Context Protocol) server configuration — only if you add one
- **What:** If you choose to connect the extension to a third-party remote MCP server (a feature for extending the agent with external tools), the extension stores the server's URL, display name, whether it's enabled, and any credentials you supply for it (a bearer token, a custom header value, or OAuth client/access/refresh tokens).
- **Where stored:** `chrome.storage.local`, unencrypted.
- **Where it goes:** Credentials and tool-call requests are sent only to the third-party server URL you configured — not to Kilo Code's backend, except that the results of those tool calls may be included as context in messages sent to the Kilo Code chat completions API, the same as any other tool result in your conversation.
- **Note:** Because you supply the server address and credentials yourself, this data flow is under your control and goes to infrastructure you choose, which may not be operated by Kilo Code.

### 6. Model and organization metadata
- **What:** The list of available AI models and organizations your account can use, fetched from `app.kilo.ai`.
- **Where stored:** In-memory only (page/session cache); not written to persistent storage.

## What we do NOT collect or access

- **No content scripts** run automatically on any page you visit; the extension never reads a page unless you explicitly invoke a tool against the currently selected tab from the side panel.
- **No browsing history** — the extension does not use the browser's history API.
- **No cookie access** — the extension does not use the browser's cookies API and its tools are explicitly designed not to read cookies.
- **No network traffic interception** — the extension does not use the browser's web-request API.
- **No analytics, telemetry, crash reporting, or advertising SDKs** are included in the extension (no PostHog, Segment, Mixpanel, Sentry, Amplitude, or similar).
- **No `chrome.storage.sync`** is used — nothing is synced by the browser vendor across your signed-in devices; all local data stays on the single machine/profile where you installed the extension.
- **No sale of data** to third parties, and no advertising use of any data described above.
- **No keystroke logging.**
- **No third-party website can message the extension directly** (the extension does not declare itself externally connectable).

## Data retention

- Authentication tokens, organization selection, conversation history, and remote MCP server configuration remain in `chrome.storage.local` until you delete a conversation, sign out, remove a remote MCP server, or uninstall the extension, at which point the corresponding local data is removed.
- Data sent to the Kilo Code backend (`app.kilo.ai`) is retained according to the [Kilo Code cloud service's Privacy Policy](https://kilo.ai/privacy) and Terms of Service, not this document.
- Data sent to a user-configured remote MCP server is retained according to that third-party server operator's own policies, which Kilo Code does not control.

## Third-party sharing

- The extension sends data to the Kilo Code backend (`app.kilo.ai`) as described above, to provide the core chat/agent functionality you're using.
- If you configure a remote MCP server, the extension sends data to that server as described above, at your direction.
- The extension does not otherwise share, sell, or transmit your data to any other third party.

## Your controls

- **Sign out** at any time from the side panel to remove your stored authentication token and email locally.
- **Delete conversations** individually from the side panel's conversation history to remove their stored content from `chrome.storage.local`.
- **Remove a remote MCP server** to delete its stored URL and credentials from local storage.
- **Use "safe mode"** (the default) to restrict the agent to read-only tools (page snapshot, screenshot, tab listing) with no script execution; enable "dangerous mode" only if you intentionally want the agent to run scripts in a page on your behalf.
- **Uninstall the extension** to remove all locally stored data (`chrome.storage.local`) associated with it from your browser.

## Changes to this policy

If this extension's data practices change, this document will be updated and the "Last updated" date above will reflect the change. Material changes will be reflected in the extension's release notes.

## Contact

For questions about this privacy policy or the extension's data practices, contact Kilo Code support: support@kilo.ai
