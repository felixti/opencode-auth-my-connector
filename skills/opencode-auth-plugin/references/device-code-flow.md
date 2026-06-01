# Device-code OAuth 2.0 flow + Microsoft Entra ID specifics

Read this for the mechanics of the device authorization grant (RFC 8628) and the concrete
Entra ID endpoints, scopes, and app-registration steps used in the template.

## Why device-code

The device authorization grant exists for inputs-constrained or browser-less contexts. In
opencode terms: when the machine running opencode can't pop a browser or can't receive a
`http://127.0.0.1:<port>/callback` redirect — SSH sessions, Docker containers, a VPS, CI.
Instead of a redirect, the IdP hands the CLI a short `user_code`; the user opens a
verification URL on any device (laptop, phone), enters the code, and approves. The CLI
polls until approval.

If a local browser *is* available, a loopback-redirect flow is smoother — but device-code
works everywhere, which is why it's the safe default for a remote/headless connector.

## The flow, step by step

1. **Request a device code.** POST to the device authorization endpoint with `client_id`
   and `scope`. Response:

   ```json
   {
     "device_code": "long-opaque-string",
     "user_code": "ABCD-1234",
     "verification_uri": "https://microsoft.com/devicelogin",
     "expires_in": 900,
     "interval": 5
   }
   ```

2. **Show the user `verification_uri` + `user_code`.** In the opencode `auth` hook this is
   the `url` and `instructions` you return from `authorize` (use `method: "auto"`).

3. **Poll the token endpoint.** Every `interval` seconds, POST with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `client_id`, and
   `device_code`. Handle the response:

   - **200** -> done. Body has `access_token`, usually `refresh_token` (only if
     `offline_access` was requested), and `expires_in`.
   - **400 `authorization_pending`** -> user hasn't approved yet; keep polling.
   - **400 `slow_down`** -> polling too fast; add ~5s to the interval and continue.
   - **400 `expired_token`** -> the `user_code` expired; the flow failed, restart.
   - **400 `authorization_declined` / `access_denied`** -> user said no; fail.

   Stop when you succeed, hit a fatal error, or pass `expires_in`.

4. **Store tokens.** Return `{ type: "success", access, refresh, expires }` with `expires`
   as an absolute epoch-ms timestamp. opencode writes them to `auth.json`.

5. **Refresh later.** When `access` expires, POST `grant_type=refresh_token` with
   `client_id`, `refresh_token`, and `scope`. Persist the new tokens via
   `client.auth.set`. Note: Entra may not return a new `refresh_token` on every refresh —
   reuse the previous one when it's absent so you don't lose refresh ability.

## Microsoft Entra ID (Azure AD) specifics

### Endpoints (v2.0)

| Purpose | URL |
| --- | --- |
| Device authorization | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode` |
| Token (poll + refresh) | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` |

`{tenant}` is your tenant GUID, a verified domain, or one of `common`,
`organizations`, `consumers`. Use a specific tenant for single-tenant apps.

### Scopes

- Always include `offline_access` — without it Entra returns **no** `refresh_token`.
- `openid profile` are useful for identity claims.
- Add the resource scope for the API you call. Entra uses the `<resource>/.default` form
  for app-registered APIs:
  - Azure OpenAI: `https://cognitiveservices.azure.com/.default`
  - A custom API you registered: `api://<application-id-uri>/.default`

Example: `openid profile offline_access https://cognitiveservices.azure.com/.default`

### App registration (one-time, in the Azure portal)

1. **Microsoft Entra ID -> App registrations -> New registration.** Give it a name. For a
   personal/dev connector, "Accounts in this organizational directory only" is typical.
2. Copy the **Application (client) ID** -> this is `CLIENT_ID`. Copy the **Directory
   (tenant) ID** -> this is `TENANT`.
3. **Authentication -> Advanced settings -> Allow public client flows -> Yes.** The
   device-code grant is a public-client flow; it will fail without this.
4. **API permissions** -> add the permission for the resource you're calling (e.g. Azure
   OpenAI / Cognitive Services) and grant consent if your tenant requires admin consent.
5. No client secret is needed for the device-code (public client) flow.

### What the user sees

```
Open https://microsoft.com/devicelogin on any device and enter code: ABCD-1234
```

opencode then waits (polls) and stores the tokens once the user approves in the browser.

## Common pitfalls

- **No `refresh_token` returned** -> you forgot `offline_access` in `scope`.
- **`AADSTS70016`/`authorization_pending` forever** -> normal until the user approves;
  make sure you actually keep polling and don't treat it as an error.
- **`AADSTS7000218` / "public client flows" error** -> "Allow public client flows" is not
  enabled on the app registration.
- **401 from the model API after login** -> the access token's audience/scope doesn't match
  the API. Recheck the resource scope (`.default`) and that the API permission is consented.
- **Token never refreshes** -> `expires` must be an absolute epoch-ms value; opencode
  refreshes when `expires < Date.now()`. Don't store the raw `expires_in` seconds.
- **Provider doesn't appear in `/connect`** -> the `auth.provider` id must exactly match a
  key under `provider` in opencode.json, and the plugin file must be in `.opencode/plugin/`
  (or listed in the `plugin` array / installed from npm).
