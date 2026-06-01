---
name: opencode-auth-plugin
description: >-
  Build an opencode auth-login plugin that authenticates a custom provider using the OAuth
  2.0 device-code flow (RFC 8628), with Microsoft Entra ID (Azure AD) as the worked example.
  Use this whenever the user wants to add login/authentication to opencode for a custom,
  internal, or enterprise model provider — e.g. creating an `opencode auth login` / `/connect`
  method, writing a plugin that uses the `auth` hook, handling device-code or headless/SSH/VPS/
  Docker OAuth, wiring access-token refresh, or connecting opencode to Azure OpenAI, Entra ID,
  or any OIDC/OAuth provider. Trigger this even when the user only says things like "add Entra
  ID login to opencode", "opencode custom provider OAuth", "authenticate opencode with our SSO",
  "opencode device-code auth plugin", or "let opencode log in to our internal model gateway".
---

# Build an opencode auth-login plugin (device-code OAuth 2.0)

This skill produces a complete, working opencode plugin that adds a custom provider to
`opencode auth login` / `/connect` and authenticates it with the OAuth 2.0 **device-code
flow** — the right choice when opencode runs where a browser can't reach a loopback redirect
(SSH, Docker, a VPS, CI). The user authenticates by opening a URL and typing a short code on
any device. Microsoft Entra ID (Azure AD) is the worked example, but the same wiring fits any
IdP that supports the device authorization grant.

The deliverable is three small files: the plugin (`.ts`), a matching `opencode.json` provider
entry, and a short README/setup note. Most of the work is mechanical — start from the bundled
template and change the OAuth details. Don't write the polling/refresh logic from scratch.

## Mental model: how opencode auth works

opencode separates **authenticating** (getting a token) from **using** it (calling the API):

- A plugin returns an `auth` hook: `{ provider, methods, loader }`.
- `methods` are what the login UI lists. An `oauth` method's `authorize()` runs the flow and
  returns tokens; opencode stores them in `~/.local/share/opencode/auth.json` under the
  provider id.
- `loader(getAuth, provider)` runs at request time. It returns AI-SDK options (`baseURL`,
  `apiKey`, a custom `fetch`). The custom `fetch` reads the stored token, refreshes it if
  expired, and sets the `Authorization` header.
- `opencode.json`'s `provider.<id>` entry tells opencode which AI-SDK package and models to
  use. **The provider id there must equal `auth.provider`** — that link is what makes your
  login method appear and your tokens get used.

So a device-code login is just: `authorize()` runs the device flow and returns
`{ access, refresh, expires }`; `loader`'s `fetch` injects/refreshes the bearer token.

## Before you start: gather these

For Entra ID (adapt the labels for another IdP):

- **Provider id** — short slug, e.g. `entra`. Used in both the plugin and `opencode.json`.
- **App registration**: Application (client) ID and tenant ID, with **"Allow public client
  flows" enabled** (device-code is a public-client flow — it fails without this).
- **Scopes**, including `offline_access` (required to get a refresh token) plus the resource
  scope for the API you call, e.g. `https://cognitiveservices.azure.com/.default` for Azure
  OpenAI.
- **API base URL** the model requests go to (e.g. your Azure OpenAI `.../openai/v1`), and the
  AI-SDK package — `@ai-sdk/openai-compatible` for OpenAI-compatible `/v1/chat/completions`
  endpoints (use `@ai-sdk/openai` if the model uses `/v1/responses`).

If any of these are unknown, ask the user or point them to the app-registration steps in
`references/device-code-flow.md`. Don't invent a `client_id` or endpoint.

## Workflow

### 1. Start from the template

Copy `assets/plugin-template.ts` as the plugin and `assets/opencode.json` as the config. The
template is a full, type-safe device-code plugin (device flow + polling + `loader` + token
refresh). Read `references/auth-hook-api.md` only if you need to deviate from it.

### 2. Fill in the CONFIG block

In the plugin's `CONFIG` block set: `PROVIDER` (the slug), `CLIENT_ID`, `TENANT`, `SCOPE`,
the two OAuth endpoints (already correct for Entra v2.0), and `DEFAULT_BASE_URL`. `client_id`
and `tenant` are not secrets — hardcoding them is fine, or keep the `process.env.*` overrides
for per-machine values. Leave the `auth`-hook wiring unchanged.

### 3. Add the provider to opencode.json

In the user's `opencode.json`, add `provider.<PROVIDER>` with `npm`, `name`, `options.baseURL`,
and `models`. The key MUST match `PROVIDER` in the plugin. See `assets/opencode.json`.

### 4. Install / load the plugin

opencode auto-loads `{plugin,plugins}/*.{ts,js}` from `.opencode/` (project) and
`~/.config/opencode/` (global). Two common setups:

- **Local file (simplest):** put the plugin at `.opencode/plugin/<provider>-auth.ts`. If it
  imports `@opencode-ai/plugin` / `@ai-sdk/openai-compatible`, add `assets/package.json` as
  `.opencode/package.json` so opencode runs `bun install` for them at startup.
- **npm package:** publish it and add the package name to the `plugin` array in `opencode.json`.

### 5. Test the login

Run `opencode auth login` (or `/connect` in the TUI), choose the provider's device-code
method, open the printed URL on any device, and enter the code. Then `opencode auth list`
should show the provider, and a model from it should answer a prompt. If the provider doesn't
appear, the id link in step 3 is wrong or the file isn't in a scanned directory.

## The `auth` hook at a glance

```ts
import type { Plugin } from "@opencode-ai/plugin"

export const MyAuthPlugin: Plugin = async ({ client }) => ({
  auth: {
    provider: "entra",                                   // == opencode.json provider key
    methods: [
      {
        type: "oauth",
        label: "Entra ID (device code)",
        authorize: async () => {
          // 1. POST devicecode -> { device_code, user_code, verification_uri, interval, expires_in }
          return {
            url: verification_uri,
            instructions: `Open the URL and enter code: ${user_code}`,
            method: "auto" as const,                     // opencode awaits callback() — we poll
            callback: async () => {
              // 2. poll the token endpoint until approved
              return { type: "success" as const, access, refresh, expires }   // expires = epoch ms
            },
          }
        },
      },
    ],
    loader: async (getAuth, provider) => {
      if ((await getAuth()).type !== "oauth") return {}
      return { apiKey: "oauth", baseURL, fetch: /* refresh + inject Authorization */ }
    },
  },
})
```

`method: "auto"` means opencode shows the URL/code and then just awaits your `callback()` —
exactly what device-code needs (poll inside the callback). Use `method: "code"` only for
flows where the user pastes a value back. Full field reference: `references/auth-hook-api.md`.

## Token storage & refresh

- `expires` is an **absolute epoch-millisecond timestamp** (`Date.now() + expires_in*1000`),
  not the raw seconds — opencode refreshes when `expires < Date.now()`.
- Refresh inside the `loader`'s `fetch`: if expired, POST `grant_type=refresh_token`, then
  persist with `await client.auth.set({ path: { id: PROVIDER }, body: { type: "oauth", ... } })`.
- Entra may omit `refresh_token` on a refresh response — reuse the previous one when absent.

## Adapting to other providers

Only the OAuth details change: swap the device + token endpoints, `client_id`, and `scope`.
The opencode `auth`-hook structure stays identical. If a local browser is available, a
loopback-server flow (also `method: "auto"`, but the callback awaits an HTTP redirect instead
of polling) is an alternative — but device-code works everywhere and is the safe default.

For OAuth error handling (`authorization_pending`, `slow_down`, expiry), Entra app-registration
steps, scopes, and a troubleshooting checklist, read `references/device-code-flow.md`.

## Reference files

- `assets/plugin-template.ts` — the full device-code auth plugin. Start here.
- `assets/opencode.json` — provider config template (id must match the plugin).
- `assets/package.json` — dependencies for local plugins (`.opencode/package.json`).
- `references/auth-hook-api.md` — exact `auth` hook / `AuthOAuthResult` / `Auth` types and the
  `loader` pattern.
- `references/device-code-flow.md` — RFC 8628 mechanics, Entra ID endpoints/scopes/app setup,
  and common pitfalls.
