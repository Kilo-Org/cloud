# Email Templates

These HTML files are server-rendered transactional email templates, sent via Mailgun. Variables use `{{ variable_name }}` syntax and are substituted in `renderTemplate()` in [`src/lib/email.ts`](../lib/email.ts).

## Styling

All templates use a light-mode design system aligned with the Customer.io marketing template:

| Property                      | Value                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| Font                          | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif` |
| Page background               | `#ffffff`                                                                             |
| Content width                 | 520px max                                                                             |
| H1 / strong / emphasis        | `#1a1a1a`, 24px/700                                                                   |
| Body text                     | `#333`, 14–15px, line-height 1.5–1.7                                                  |
| Secondary text (inside boxes) | `#555`, 13–14px                                                                       |
| Inline links                  | `#1a1a1a` underlined                                                                  |
| Info-box background           | `#f6f6f4`                                                                             |
| Info-box border               | `1px solid #ebebea`                                                                   |
| Info-box border-radius        | `10px`                                                                                |
| Primary CTA button background | `#1a1a1a`                                                                             |
| Primary CTA button text       | `#ffffff`, 13px/600, `border-radius: 7px`, `padding: 10px 20px`                       |
| Section divider               | `1px solid #ebebea`                                                                   |
| Footer divider                | `1px solid #eee`                                                                      |
| Footer legal / address        | `#ccc`, 11px                                                                          |

## Content Guidelines

All templates in this directory are **transactional** emails sent via `app.kilocode.ai`. Keep content factual and account-status focused:

- State what changed and what the user needs to know.
- A single CTA linking to the relevant page in the app is appropriate.
- Do **not** include sales copy, upsell blocks, pricing language, or secondary CTAs promoting features or plans.
- The footer company name is **Kilo Code, Inc** — never "LLC".

## Footer

Every template must include this branding footer below the content table:

```html
<!-- Branding Footer -->
<table width="520" cellpadding="0" cellspacing="0">
  <tr>
    <td align="center" style="padding: 30px 20px; border-top: 1px solid #eee">
      <p
        style="
          margin: 0;
          font-size: 11px;
          color: #ccc;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica,
            Arial, sans-serif;
        "
      >
        © {{ year }} Kilo Code, Inc<br />455 Market St, Ste 1940 PMB 993504<br />San Francisco, CA
        94105, USA
      </p>
    </td>
  </tr>
</table>
```

## Template Variables

| Template file                          | Variables                                                                                                                  | Customer.io ID (crosswalk) |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `orgSubscription.html`                 | `seats`, `organization_url`, `invoices_url`, `year`                                                                        | `10`                       |
| `orgRenewed.html`                      | `seats`, `invoices_url`, `year`                                                                                            | `11`                       |
| `orgCancelled.html`                    | `invoices_url`, `year`                                                                                                     | `12`                       |
| `orgSSOUserJoined.html`                | `new_user_email`, `organization_url`, `year`                                                                               | `13`                       |
| `orgInvitation.html`                   | `organization_name`, `inviter_name`, `accept_invite_url`, `year`                                                           | `6`                        |
| `magicLink.html`                       | `magic_link_url`, `email`, `expires_in`, `year`                                                                            | `14`                       |
| `balanceAlert.html`                    | `minimum_balance`, `organization_url`, `year`                                                                              | `16`                       |
| `autoTopUpFailed.html`                 | `reason`, `credits_url`, `year`                                                                                            | `17`                       |
| `ossInviteNewUser.html`                | `tier_name`, `seats`, `seat_value`, `credits_section`, `accept_invite_url`, `integrations_url`, `code_reviews_url`, `year` | `18`                       |
| `ossInviteExistingUser.html`           | `tier_name`, `seats`, `seat_value`, `credits_section`, `organization_url`, `integrations_url`, `code_reviews_url`, `year`  | `19`                       |
| `ossExistingOrgProvisioned.html`       | `tier_name`, `seats`, `seat_value`, `credits_section`, `organization_url`, `integrations_url`, `code_reviews_url`, `year`  | `20`                       |
| `deployFailed.html`                    | `deployment_name`, `deployment_url`, `repository`, `year`                                                                  | `21`                       |
| `clawTrialEndingSoon.html`             | `days_remaining`, `claw_url`, `year`                                                                                       | `22`                       |
| `clawTrialExpiresTomorrow.html`        | `claw_url`, `year`                                                                                                         | `23`                       |
| `clawSuspendedTrial.html`              | `destruction_date`, `claw_url`, `year`                                                                                     | `24`                       |
| `clawSuspendedSubscription.html`       | `destruction_date`, `claw_url`, `year`                                                                                     | `25`                       |
| `clawSuspendedPayment.html`            | `destruction_date`, `claw_url`, `year`                                                                                     | `26`                       |
| `clawDestructionWarning.html`          | `destruction_date`, `claw_url`, `year`                                                                                     | `27`                       |
| `clawInstanceDestroyed.html`           | `claw_url`, `year`                                                                                                         | `28`                       |
| `clawEarlybirdEndingSoon.html`         | `days_remaining`, `expiry_date`, `claw_url`, `year`                                                                        | `29`                       |
| `clawEarlybirdExpiresTomorrow.html`    | `expiry_date`, `claw_url`, `year`                                                                                          | `30`                       |
| `clawComplementaryInferenceEnded.html` | `claw_url`, `year`                                                                                                         | —                          |
| `accountDeletionRequest.html`          | `email`, `year`                                                                                                            | —                          |
