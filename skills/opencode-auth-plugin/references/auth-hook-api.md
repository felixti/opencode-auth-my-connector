# opencode `auth` hook — API reference

This is the exact shape of the plugin `auth` hook (from `@opencode-ai/plugin`'s type
definitions) plus the credential types it works with. Read this when you need to know
what a field means or what a function must return. The wiring is small and stable; the
provider-specific OAuth details (endpoints, scopes) are the only part you customize.

## The plugin and its hooks

A plugin is a function that receives a context object and returns a hooks object:

```ts
export type Plugin = (input: PluginInput) => Promise<Hooks>
```

`PluginInput` includes:

- `client` — the opencode SDK client. Use `client.auth.set(...)` to persist refreshed
  tokens and `client.app.log(...)` for structured logs.
- `project`, `directory`, `worktree`, `$` (Bun shell), `serverUrl`.

The `auth` hook lives on the returned `Hooks` object: `{ auth: AuthHook }`.

## `AuthHook`

```ts
type AuthHook = {
  provider: string            // MUST equal the provider id in opencode.json
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>
  methods: Array<OAuthMethod | ApiMethod>
}
```

### `methods` — what the login UI offers

`opencode auth login` and the TUI `/connect` command list each method's `label` under
this provider. Two kinds:

```ts
type OAuthMethod = {
  type: "oauth"
  label: string
  prompts?: Prompt[]                                 // optional pre-flow inputs (see below)
  authorize: (inputs?: Record<string, string>) => Promise<AuthOAuthResult>
}

type ApiMethod = {
  type: "api"
  label: string
  prompts?: Prompt[]
  // If omitted, opencode just prompts for and stores an API key. Provide it only if you
  // need to validate/transform the key before storing.
  authorize?: (inputs?: Record<string, string>) =>
    Promise<{ type: "success"; key: string; provider?: string; metadata?: Record<string,string> }
           | { type: "failed" }>
}
```

`prompts` collect input before `authorize` runs (e.g. ask for a tenant or region). Each is
a `{ type: "text" }` or `{ type: "select" }` with a `key`; the collected values arrive as
the `inputs` argument to `authorize`. Use this when the value differs per user; bake in
fixed values (like a registered `client_id`) as constants instead.

### `authorize` return — `AuthOAuthResult`

```ts
type AuthOAuthResult = {
  url: string            // shown to the user
  instructions: string   // shown to the user (put the device user-code here)
} & (
  | { method: "auto"; callback: () => Promise<SuccessOrFailed> }
  | { method: "code"; callback: (code: string) => Promise<SuccessOrFailed> }
)
```

- **`method: "auto"`** — opencode shows `url`/`instructions` and then awaits your
  `callback()` (no value pasted back). This is the right mode for the **device-code flow**
  (poll the token endpoint inside the callback) and for a loopback HTTP-server flow (wait
  for the redirect inside the callback).
- **`method: "code"`** — opencode shows `url`/`instructions`, the user pastes a value back,
  and opencode passes it to `callback(code)`. Use for classic "copy this code from the
  browser" flows.

`callback` resolves to success or failure:

```ts
type SuccessOrFailed =
  | { type: "success"; provider?: string; refresh: string; access: string; expires: number }
  | { type: "success"; provider?: string; key: string; metadata?: Record<string, string> }
  | { type: "failed" }
```

For OAuth tokens, return the `{ refresh, access, expires }` form. `expires` is an
**absolute epoch-millisecond timestamp** (e.g. `Date.now() + expires_in * 1000`).

### `loader` — turning credentials into a working client

`loader(getAuth, provider)` returns the AI-SDK options opencode uses to call the provider.
It runs with access to the stored credential and the provider's `opencode.json` entry.

- `getAuth()` returns the current stored `Auth`. Call it again inside your custom `fetch`
  to get fresh credentials right before each request.
- `provider` is the `opencode.json` `provider.<id>` object; read `provider.options.baseURL`
  etc. from it.
- Return an object merged into the AI-SDK provider config. Common keys: `apiKey`, `baseURL`,
  `headers`, and a custom `fetch`. Return `{}` to opt out (e.g. for non-oauth auth types).

The standard pattern is a custom `fetch` that (1) refreshes the token if expired and
persists it, then (2) sets the `Authorization` header:

```ts
loader: async (getAuth, provider) => {
  if ((await getAuth()).type !== "oauth") return {}        // let opencode handle api keys
  const baseURL = (provider as any)?.options?.baseURL ?? DEFAULT_BASE_URL
  return {
    apiKey: "oauth",                                       // placeholder; real cred is the header
    baseURL,
    fetch: async (input, init) => {
      let auth = await getAuth()
      if (auth.type === "oauth" && auth.expires < Date.now()) {
        const token = await refreshTokens(auth.refresh)
        const next = { type: "oauth" as const, access: token.access_token,
                       refresh: token.refresh_token ?? auth.refresh,
                       expires: Date.now() + token.expires_in * 1000 }
        await client.auth.set({ path: { id: PROVIDER }, body: next })
        auth = next
      }
      const headers = new Headers(init?.headers)
      headers.set("Authorization", `Bearer ${auth.type === "oauth" ? auth.access : ""}`)
      return fetch(input, { ...init, headers })
    },
  }
}
```

## Credential types (`Auth`) and persistence

opencode stores credentials in `~/.local/share/opencode/auth.json`, keyed by provider id.
The stored value is one of:

```ts
type Auth =
  | { type: "oauth"; refresh: string; access: string; expires: number; enterpriseUrl?: string }
  | { type: "api"; key: string; metadata?: Record<string, string> }
  | { type: "wellknown"; key: string; token: string }
```

Persist refreshed tokens with the SDK client:

```ts
await client.auth.set({ path: { id: PROVIDER }, body: { type: "oauth", access, refresh, expires } })
```

`opencode auth list` shows which providers have stored credentials; `opencode auth logout`
removes them.

## TypeScript note

Type the plugin as `Plugin` and let the callback/loader parameters be inferred from the
context — you do not need to import `Auth` or `Provider` yourself. Add `as const` to the
discriminant literals (`method: "auto" as const`, `type: "success" as const`,
`type: "failed" as const`) so they narrow to the union members instead of widening to
`string`.
