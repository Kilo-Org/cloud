# UX Writing

> Adapted from Impeccable's `ux-writing.md` (Apache 2.0). See `NOTICE.md`
> for attribution and upstream source.

## Kilo application

Kilo voice is **clear, technical, calm, and direct**. Engineering-literate
audience. No hype, no cutesy error copy, no vague productivity slogans.

### Kilo voice in one paragraph

Kilo talks to developers and team leads. Say what the product does, what
the user needs to do next, and what will happen if they do it. Skip
adjectives like "powerful," "seamless," "effortless," and "revolutionary."
Prefer concrete verbs and specific nouns.

### Terminology to pick and keep

Pick one term per concept and hold it across web, mobile, docs, and UI:

| Use                | Not                                                              |
| ------------------ | ---------------------------------------------------------------- |
| Sign in / Sign out | Log in, Log out, Enter, Exit                                     |
| Delete             | Remove, Trash, Clear (for destructive ops)                       |
| Settings           | Preferences, Options, Configuration                              |
| Create             | Add, New (for creating a persistent thing)                       |
| Workspace          | Team, Account, Org (if "workspace" is what the product calls it) |
| Kilo Code          | KiloCode, kilo-code (product name)                               |

If this repo has a newer glossary, prefer that. Do not invent synonyms
to add variety.

### Button labels

Use verb + object. Specific over generic. Kilo-flavored examples:

| Bad        | Good                 |
| ---------- | -------------------- |
| OK         | Save changes         |
| Submit     | Create workspace     |
| Yes        | Delete project       |
| Cancel     | Keep editing         |
| Click here | View billing history |

For destructive actions, name the destruction and the count:

- "Delete 5 invites"
- "Delete workspace permanently"
- "Remove member from team"

### Error copy

Every error should answer: (1) what happened, (2) why (if knowable),
(3) what to try next.

Kilo-flavored patterns:

- `Can't reach Stripe. Check your connection and try again.`
- `Invalid token. Sign in again to refresh your session.`
- `Email must include an @ symbol. Example: you@example.com`
- `You don't have access to this workspace. Ask an admin for an invite.`
- `Something went wrong on our end. Our team has been notified. Try again in a minute.`

Do **not**:

- Blame the user: "You entered an invalid date" → "Please enter a date as
  MM/DD/YYYY".
- Use humor in errors — users are already frustrated.
- Emit stack traces in user-facing copy.
- Use `Error: ` prefixes in user-facing messages (the UI treatment already
  signals an error).

### Empty states

Acknowledge, explain value, provide a clear action. Examples:

- `No workspaces yet. Create one to invite your team and start billing.`
- `No invoices yet. Your first invoice will appear after your trial ends.`
- `No API keys. Create one to connect Kilo Code to your IDE.`

### Loading copy

Be specific. `Creating workspace…` beats `Loading…`. For long waits, set
expectations: `Provisioning machine. This usually takes 30–60 seconds.`

### Confirmation copy

Confirm only for truly irreversible or high-stakes actions. Name the
action in both buttons:

- `Delete workspace permanently?`  
  Primary: `Delete workspace` (destructive variant).  
  Secondary: `Keep workspace`.

### Accessibility copy

- Link text must stand alone: `View pricing plans`, not `Click here`.
- Alt text describes information, not the image:
  `Revenue increased 40% in Q4`, not `Chart`.
- Use `alt=""` for decorative images.
- Icon-only buttons need `aria-label`.

### Translation / i18n

- German and Finnish can be ~30% longer than English. Plan layout for
  expansion.
- Keep full sentences as single strings; word order changes between
  languages.
- Avoid abbreviations (`5 minutes ago`, not `5m ago`) unless space is
  actually constrained.
- When adding new strings, structure them to allow a translator context.

### Absolute rejects in Kilo copy

- "Submit" / "OK" / "Yes/No" as primary labels.
- "Oops!" / "Whoops" / "Uh oh" in any user-facing error.
- Emoji in error messages.
- Em dashes "—" in UI copy. Use commas, colons, semicolons, or
  parentheses. Also not `--`.
- "Powerful," "seamless," "revolutionary," "unlock" as adjectives.
- Undifferentiated terminology: using `delete` / `remove` / `trash`
  interchangeably in the same product surface.

---

## The Button Label Problem

Never use `OK`, `Submit`, or `Yes`/`No`. Use specific verb + object:

| Bad        | Good           | Why                           |
| ---------- | -------------- | ----------------------------- |
| OK         | Save changes   | Says what will happen         |
| Submit     | Create account | Outcome-focused               |
| Yes        | Delete message | Confirms the action           |
| Cancel     | Keep editing   | Clarifies what "cancel" means |
| Click here | Download PDF   | Describes the destination     |

For destructive actions, name the destruction:

- `Delete`, not `Remove` (delete is permanent; remove implies
  recoverable).
- `Delete 5 items`, not `Delete selected` (show the count).

## Error Messages: The Formula

Every error should answer: (1) what happened, (2) why, (3) how to fix it.
`Email address isn't valid. Please include an @ symbol.` beats
`Invalid input`.

### Error message templates

| Situation         | Template                                                        |
| ----------------- | --------------------------------------------------------------- |
| Format error      | "[Field] needs to be [format]. Example: [example]"              |
| Missing required  | "Please enter [what's missing]"                                 |
| Permission denied | "You don't have access to [thing]. [What to do instead]"        |
| Network error     | "We couldn't reach [thing]. Check your connection and [action]" |
| Server error      | "Something went wrong on our end. We're looking into it."       |

### Don't blame the user

Reframe errors: `Please enter a date in MM/DD/YYYY format` not
`You entered an invalid date`.

## Empty States Are Opportunities

Empty states are onboarding moments:

1. Acknowledge briefly.
2. Explain the value of filling it.
3. Provide a clear action.

`No projects yet. Create your first one to get started.` not just
`No items`.

## Voice vs Tone

**Voice** is your brand's personality — consistent everywhere. **Tone**
adapts to the moment.

| Moment              | Tone shift                                                   |
| ------------------- | ------------------------------------------------------------ |
| Success             | Celebratory, brief: "Done! Your changes are live."           |
| Error               | Empathetic, helpful: "That didn't work. Here's what to try…" |
| Loading             | Reassuring: "Saving your work…"                              |
| Destructive confirm | Serious, clear: "Delete this project? This can't be undone." |

Never use humor for errors.

## Writing for Accessibility

- **Link text** must have standalone meaning — `View pricing plans`, not
  `Click here`.
- **Alt text** describes information, not the image — `Revenue increased
40% in Q4`, not `Chart`.
- Use `alt=""` for decorative images.
- **Icon buttons** need `aria-label` for screen reader context.

## Writing for Translation

### Plan for expansion

German text is ~30% longer than English. Allocate space:

| Language | Expansion                      |
| -------- | ------------------------------ |
| German   | +30%                           |
| French   | +20%                           |
| Finnish  | +30–40%                        |
| Chinese  | -30% (fewer chars, same width) |

### Translation-friendly patterns

- Keep numbers separate (`New messages: 3`, not `You have 3 new
messages`).
- Use full sentences as single strings (word order varies by language).
- Avoid abbreviations (`5 minutes ago`, not `5 mins ago`).
- Give translators context about where strings appear.

## Consistency: The Terminology Problem

Pick one term and stick with it. Build a terminology glossary and
enforce it. Variety creates confusion.

## Avoid Redundant Copy

If the heading explains it, the intro is redundant. If the button is
clear, don't explain it again. Say it once, say it well.

## Loading States

Be specific: `Saving your draft…`, not `Loading…`. For long waits, set
expectations (`This usually takes 30 seconds`) or show progress.

## Confirmation Dialogs: Use Sparingly

Most confirmation dialogs are design failures — consider undo instead.
When you must confirm: name the action, explain consequences, use
specific button labels (`Delete project` / `Keep project`, not
`Yes` / `No`).

## Form Instructions

Show format with placeholders, not instructions. For non-obvious fields,
explain why you're asking.

---

**Avoid**: Jargon without explanation. Blaming users
(`You made an error` → `This field is required`). Vague errors
(`Something went wrong`). Varying terminology for variety. Humor for
errors.
