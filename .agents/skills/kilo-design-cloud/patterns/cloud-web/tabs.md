# Cloud Web Pattern: Tabs

Pattern ID: `cloud-web.tabs`

## When To Use

Use this recipe for Cloud tab bars, segmented navigation, Radix tab groups, and active tab state review.

## Rule

Use the Cloud shadcn/Radix tabs primitive. Tabs are compact, neutral, and structural. They should not compete with the page's primary action.

## Canonical Example

Real code to copy:

- `apps/web/src/components/ui/tabs.tsx`
- `TabsList`: `bg-muted text-muted-foreground inline-flex h-9 ... rounded-lg p-1`
- `TabsTrigger`: compact trigger with active `text-foreground`, border, transparent fill, and shadow

## Implementation Rules

- Import `Tabs`, `TabsList`, `TabsTrigger`, and `TabsContent` from `@/components/ui/tabs`.
- Do not hand-roll tabs with buttons, anchors, or custom state when Radix tabs fit.
- Keep tab lists compact: `h-9`, `p-1`, `rounded-lg`.
- Use neutral active states. Do not use brand primary or status colors for normal active tabs.
- Keep labels short and scannable. Avoid invented category names.
- Preserve keyboard behavior by using the Radix wrapper.
- Keep tab content spacing connected to the tab list; do not turn every panel into a nested card.

## Review Checklist

- Does the surface use the shared tabs primitive?
- Is the active state neutral and readable?
- Is keyboard behavior preserved?
- Are tab labels short and concrete?
- Is the tab group subordinate to the page's main task?

## Known Drift

The current primitive is the Canonical Example. If a future Cloud surface needs a different tab density or orientation, record the need as a coverage gap before creating another tab style.
