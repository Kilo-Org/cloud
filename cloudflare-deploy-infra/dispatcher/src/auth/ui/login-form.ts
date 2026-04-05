/**
 * HTML login form renderer for password-protected workers.
 * Renders a simple, clean dark-mode login page using Hono's html template.
 */

import { html, raw } from 'hono/html';

type LoginFormOptions = {
  workerName: string;
  returnPath: string;
  error?: string;
};

const styles = raw(`<style>
    *, *::before, *::after {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 20px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
    }
    .container {
      width: 100%;
      max-width: 360px;
      padding: 32px;
      background: #171717;
      border: 1px solid #262626;
      border-radius: 12px;
    }
    h1 {
      margin: 0 0 8px 0;
      font-size: 24px;
      font-weight: 600;
      color: #fafafa;
    }
    .subtitle {
      margin: 0 0 24px 0;
      font-size: 14px;
      color: #a3a3a3;
    }
    .error {
      margin: 0 0 16px 0;
      padding: 12px;
      background: rgba(220, 38, 38, 0.1);
      border: 1px solid rgba(220, 38, 38, 0.3);
      border-radius: 8px;
      color: #fca5a5;
      font-size: 14px;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    input[type="password"] {
      width: 100%;
      padding: 12px 14px;
      font-size: 16px;
      background: #0a0a0a;
      border: 1px solid #404040;
      border-radius: 8px;
      color: #fafafa;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type="password"]:focus {
      border-color: #0ea5e9;
    }
    input[type="password"]::placeholder {
      color: #737373;
    }
    button[type="submit"] {
      width: 100%;
      padding: 12px 16px;
      font-size: 16px;
      font-weight: 500;
      background: #0ea5e9;
      border: none;
      border-radius: 8px;
      color: #fff;
      cursor: pointer;
      transition: background 0.15s;
    }
    button[type="submit"]:hover {
      background: #0284c7;
    }
    button[type="submit"]:active {
      background: #0369a1;
    }
    .footer {
      margin: 24px 0 0 0;
      padding-top: 16px;
      border-top: 1px solid #262626;
      font-size: 12px;
      color: #525252;
      text-align: center;
    }
    .footer a {
      color: #525252;
      text-decoration: none;
    }
    .footer a:hover {
      color: #a3a3a3;
    }
  </style>`);

/**
 * Renders a complete HTML login page for password-protected workers.
 * Works without JavaScript and uses dark-mode styling.
 * Uses Hono's html template for automatic XSS escaping.
 *
 * @param options - Configuration for the login form
 * @returns HtmlEscapedString that can be used with c.html()
 */
export function renderLoginForm(options: LoginFormOptions) {
  const { workerName, returnPath, error } = options;

  return html`<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Protected - ${workerName}</title>
        ${styles}
      </head>
      <body>
        <div class="container">
          <h1>Password Protected</h1>
          <p class="subtitle">Enter password to access ${workerName}</p>
          ${error ? html`<div class="error">${error}</div>` : ''}
          <form method="POST" action="/__auth">
            <input type="password" name="password" placeholder="Password" required autofocus />
            <input type="hidden" name="return" value="${returnPath}" />
            <button type="submit">Continue</button>
          </form>
        </div>
      </body>
    </html>`;
}
