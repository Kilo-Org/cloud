# Email Templates

These HTML files are server-rendered transactional email templates, sent via Mailgun. Variables use `{{ variable_name }}` syntax and are substituted in `renderTemplate()` in [`src/lib/email.ts`](../lib/email.ts).

## Styling

All templates use the Kilo brand design system:

| Property                | Value                                                 |
| ----------------------- | ----------------------------------------------------- |
| Font                    | `'JetBrains Mono', 'Courier New', Courier, monospace` |
| Page background         | `#1a1a1a`                                             |
| Card background         | `#2a2a2a`                                             |
| Card border             | `1px solid #3a3a3a`                                   |
| H1 color                | `#f4e452` (yellow)                                    |
| Body text               | `#9ca3af` (gray)                                      |
| Strong / emphasis text  | `#d1d5db` (light gray)                                |
| Links                   | `#f4e452` (yellow)                                    |
| CTA button background   | `#f4e452` (yellow)                                    |
| CTA button text         | `#6b7280` (dark gray)                                 |
| Footer / secondary text | `#6b7280`                                             |
| Section divider         | `1px solid #3a3a3a`                                   |

## Footer

Every template must include this branding footer below the card:

```html
<!-- Branding Footer -->
<table width="600" cellpadding="0" cellspacing="0">
  <tr>
    <td align="center" style="padding: 30px 20px">
      <p
        style="
          margin: 0;
          font-size: 12px;
          color: #6b7280;
          font-family: 'JetBrains Mono', 'Courier New', Courier, monospace;
        "
      >
        © {{ year }} Kilo Code, LLC<br />455 Market St, Ste 1940 PMB 993504<br />San Francisco, CA
        94105, USA
      </p>
    </td>
  </tr>
</table>
```

## Template Variables

| Template file                    | Variables                                                                                                                  | Customer.io ID (crosswalk) |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `orgSubscription.html`           | `seats`, `organization_url`, `invoices_url`, `year`                                                                        | `10`                       |
| `orgRenewed.html`                | `seats`, `invoices_url`, `year`                                                                                            | `11`                       |
| `orgCancelled.html`              | `invoices_url`, `year`                                                                                                     | `12`                       |
| `orgSSOUserJoined.html`          | `new_user_email`, `organization_url`, `year`                                                                               | `13`                       |
| `orgInvitation.html`             | `organization_name`, `inviter_name`, `accept_invite_url`, `year`                                                           | `6`                        |
| `magicLink.html`                 | `magic_link_url`, `email`, `expires_in`, `year`                                                                            | `14`                       |
| `balanceAlert.html`              | `minimum_balance`, `organization_url`, `year`                                                                              | `16`                       |
| `autoTopUpFailed.html`           | `reason`, `credits_url`, `year`                                                                                            | `17`                       |
| `ossInviteNewUser.html`          | `tier_name`, `seats`, `seat_value`, `credits_section`, `accept_invite_url`, `integrations_url`, `code_reviews_url`, `year` | `18`                       |
| `ossInviteExistingUser.html`     | `tier_name`, `seats`, `seat_value`, `credits_section`, `organization_url`, `integrations_url`, `code_reviews_url`, `year`  | `19`                       |
| `ossExistingOrgProvisioned.html` | `tier_name`, `seats`, `seat_value`, `credits_section`, `organization_url`, `integrations_url`, `code_reviews_url`, `year`  | `20`                       |
| `deployFailed.html`              | `deployment_name`, `deployment_url`, `repository`, `year`                                                                  | `21`                       |
