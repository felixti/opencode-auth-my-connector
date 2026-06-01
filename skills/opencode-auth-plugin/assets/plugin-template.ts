/**
 * opencode auth-login plugin — device-code OAuth 2.0 (RFC 8628)
 *
 * Worked example: Microsoft Entra ID (Azure AD) -> an OpenAI-compatible endpoint
 * (e.g. Azure OpenAI). The device-code grant is the right choice when opencode runs
 * somewhere a browser can't reach a loopback redirect: SSH sessions, Docker, a VPS, CI.
 * The user authenticates by opening a URL and typing a short code on ANY device.
 *
 * HOW TO USE
 *  1. Fill in the CONFIG block below (PROVIDER, CLIENT_ID, TENANT, SCOPE, base URL).
 *  2. Drop this file in `.opencode/plugin/` (project) or `~/.config/opencode/plugin/`
 *     (global). opencode auto-loads `{plugin,plugins}/*.{ts,js}` from those dirs.
 *  3. Add a matching `provider.<PROVIDER>` entry to opencode.json (see opencode.json template).
 *  4. Run `opencode auth login` (or `/connect` in the TUI), pick this provider's method,
 *     and follow the printed URL + code.
 *
 * ADAPTING TO ANOTHER PROVIDER
 *  Any IdP that supports the OAuth 2.0 device authorization grant works. Replace the two
 *  endpoints and the CLIENT_ID/SCOPE. The opencode-facing wiring (the `auth` hook) stays
 *  identical — only the OAuth details change.
 */
import type { Plugin } from "@opencode-ai/plugin"

// ── CONFIG ───────────────────────────────────────────────────────────────────
// Provider id. MUST match the key under `provider` in opencode.json and is the id
// opencode stores the credential under (`opencode auth list` shows it).
const PROVIDER = "entra"

// Your Entra app registration. Register a "public client" / "native" app and enable
// "Allow public client flows" so the device-code grant is permitted. The client_id and
// tenant are not secrets; hardcoding them is fine, or override per machine with env vars.
const TENANT = process.env.ENTRA_TENANT_ID ?? "common" // tenant GUID, a domain, or "common"/"organizations"
const CLIENT_ID = process.env.ENTRA_CLIENT_ID ?? "00000000-0000-0000-0000-000000000000"

// Scopes. `offline_access` is REQUIRED to get a refresh_token back. Swap the resource
// scope for the API your endpoint sits behind, e.g.
//   Azure OpenAI : "https://cognitiveservices.azure.com/.default"
//   custom API   : "api://<application-id-uri>/.default"
const SCOPE =
  process.env.ENTRA_SCOPE ??
  "openid profile offline_access https://cognitiveservices.azure.com/.default"

// OAuth endpoints (Entra v2.0). Point these at any IdP's device + token endpoints.
const DEVICE_ENDPOINT = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`
const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`

// Fallback API base URL, used only if opencode.json doesn't set provider.options.baseURL.
const DEFAULT_BASE_URL =
  process.env.ENTRA_BASE_URL ?? "https://YOUR-RESOURCE.openai.azure.com/openai/v1"

// Refresh this many seconds BEFORE the token actually expires, to absorb clock skew.
const EXPIRY_BUFFER_SEC = 60
// ──────────────────────────────────────────────────────────────────────────────

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
}

/**
 * Normalize an OAuth token response into the credential fields opencode stores.
 * `expires` is an ABSOLUTE epoch-millisecond timestamp — opencode refreshes when
 * `expires < Date.now()`. Entra sometimes omits refresh_token on a refresh, so we
 * fall back to the previous one to avoid losing the ability to refresh again.
 */
function credentials(token: TokenResponse, previousRefresh?: string) {
  return {
    access: token.access_token,
    refresh: token.refresh_token ?? previousRefresh ?? "",
    expires: Date.now() + (token.expires_in - EXPIRY_BUFFER_SEC) * 1000,
  }
}

/** Exchange a refresh_token for a fresh access_token. */
async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      scope: SCOPE,
    }),
  })
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as TokenResponse
}

export const EntraAuthPlugin: Plugin = async ({ client }) => {
  return {
    auth: {
      provider: PROVIDER,

      // `methods` is the list `opencode auth login` / `/connect` shows for this provider.
      methods: [
        {
          type: "oauth",
          label: "Microsoft Entra ID (device code)",
          // `authorize` runs when the user picks this method. It returns a flow object
          // describing what to show the user and how to obtain tokens.
          authorize: async () => {
            // 1. Ask the IdP to start a device authorization and hand us a user code.
            const res = await fetch(DEVICE_ENDPOINT, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }),
            })
            if (!res.ok) {
              throw new Error(`device authorization failed: ${res.status} ${await res.text()}`)
            }
            const device = (await res.json()) as {
              device_code: string
              user_code: string
              verification_uri: string
              expires_in: number
              interval: number
            }

            const deadline = Date.now() + device.expires_in * 1000
            let intervalMs = (device.interval || 5) * 1000

            return {
              // opencode prints `url` and `instructions`; the user can use any device.
              url: device.verification_uri,
              instructions: `Open the URL above on any device and enter code: ${device.user_code}`,
              // "auto" = opencode just awaits our callback (no code pasted back). Perfect
              // for device-code: we poll the token endpoint until the user approves.
              method: "auto" as const,
              callback: async () => {
                while (Date.now() < deadline) {
                  await new Promise((r) => setTimeout(r, intervalMs))
                  const poll = await fetch(TOKEN_ENDPOINT, {
                    method: "POST",
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({
                      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                      client_id: CLIENT_ID,
                      device_code: device.device_code,
                    }),
                  })
                  if (poll.ok) {
                    const token = (await poll.json()) as TokenResponse
                    return { type: "success" as const, ...credentials(token) }
                  }
                  // Per RFC 8628 these polling errors are normal — keep waiting.
                  const err = (await poll.json().catch(() => ({}))) as { error?: string }
                  if (err.error === "authorization_pending") continue
                  if (err.error === "slow_down") {
                    intervalMs += 5000
                    continue
                  }
                  // expired_token / authorization_declined / bad_verification_code -> stop.
                  return { type: "failed" as const }
                }
                return { type: "failed" as const }
              },
            }
          },
        },
        // Optional escape hatch: let the user paste a key/token manually. opencode stores
        // it as an api credential; the loader below ignores non-oauth auth and lets
        // opencode handle the key the standard way.
        {
          type: "api",
          label: "API key (manual)",
        },
      ],

      // `loader` runs on every request to this provider. It returns the AI-SDK config
      // opencode uses to reach the API. The custom `fetch` injects the bearer token and
      // refreshes it just-in-time, persisting the new tokens with `client.auth.set`.
      loader: async (getAuth, provider) => {
        const initial = await getAuth()
        // Manual API-key auth is handled by opencode itself — nothing to wire up here.
        if (initial.type !== "oauth") return {}

        const baseURL =
          (provider as { options?: { baseURL?: string } })?.options?.baseURL ?? DEFAULT_BASE_URL

        return {
          // The OpenAI-compatible SDK requires a key; the real credential is the bearer
          // header set below, so any non-empty placeholder works here.
          apiKey: "oauth",
          baseURL,
          fetch: async (input: Request | string | URL, init?: RequestInit) => {
            let auth = await getAuth()
            if (auth.type === "oauth" && auth.expires < Date.now()) {
              const token = await refreshTokens(auth.refresh)
              const next = { type: "oauth" as const, ...credentials(token, auth.refresh) }
              await client.auth.set({ path: { id: PROVIDER }, body: next })
              auth = next
            }
            const access = auth.type === "oauth" ? auth.access : ""
            const headers = new Headers(init?.headers)
            headers.set("Authorization", `Bearer ${access}`)
            return fetch(input, { ...init, headers })
          },
        }
      },
    },
  }
}

export default EntraAuthPlugin
