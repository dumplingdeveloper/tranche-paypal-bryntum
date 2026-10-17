# Copilot SDK BYOK & judge-runnability facts (verified 2026-10-17)

Package: `@github/copilot-sdk` **1.0.15** (`"copilotCliVersion": "1.0.89"`, `"license": "MIT"`). The `dist/types.d.ts` in
`hackathon_paypal_bryntum/node_modules/@github/copilot-sdk/` is byte-identical to the one in
`hackathon_paypal/alexa-sim/node_modules/@github/copilot-sdk/` (`cmp` → identical), so the line numbers below apply to both.

## Q1. Can a judge run the agent with their own OpenAI / Anthropic / Azure key and no Copilot subscription?
**Yes — documented and verified locally.**

Docs (https://github.com/github/copilot-sdk/blob/main/docs/auth/byok.md, last commit 0dd9d43 on 2026-09-17):
- line 3: "BYOK allows you to use the Copilot SDK with your own API keys from model providers, bypassing GitHub Copilot authentication. This is useful for enterprise deployments, custom model hosting, or when you want direct billing with your model provider."
- Supported providers table: OpenAI `"openai"`, "Microsoft Foundry / Azure OpenAI" `"openai"` or `"azure"`, Anthropic `"anthropic"`, Ollama `"openai"`.
- "Limitations" (lines 494–503): "Usage tracking - Usage is tracked by your provider, not GitHub Copilot"; "Premium requests - Do not count against Copilot premium request quotas".
- line 517: "When using BYOK, the `model` parameter is **required**".

Types (`dist/types.d.ts`):
- 2009–2012 (SessionConfig): "Custom provider configuration (BYOK - Bring Your Own Key). When specified, uses the provided API endpoint instead of the Copilot API." → `provider?: ProviderConfig;`
- 2023–2024: "the singular {@link provider} — which makes the entire session BYOK and bypasses Copilot API authentication".
- 2047–2048: "When a custom {@link provider} (BYOK) is configured, session telemetry is always disabled regardless of this setting."
- 2510 `export interface ProviderConfig {`
  - 2512–2514 `type?: "openai" | "azure" | "anthropic";` ("Defaults to "openai" for generic OpenAI-compatible APIs.")
  - `wireApi?: "completions" | "responses";` ("API format (openai/azure only). Defaults to "completions".")
  - `baseUrl: string;` (required)
  - 2534 `apiKey?: string;` ("API key. Optional for local providers like Ollama.")
  - `bearerToken?: string;` ("Takes precedence over apiKey when both are set.")
  - `bearerTokenProvider?: BearerTokenProvider;` (@experimental; managed identity)
  - `azure?: { apiVersion?: string }`, `headers?`, `modelId?`, `wireModel?` (Azure deployment name), `maxPromptTokens?`, `maxOutputTokens?`
- 2608 `NamedProviderConfig` / 2679 `ProviderModelConfig` + `providers?` / `models?` (2032, 2042): "@experimental" multi-provider surface; "named providers are **additive**: they coexist with Copilot API auth". Not needed for us.
- README `node_modules/@github/copilot-sdk/README.md`:961–1020 "Custom Providers", e.g. :963 "When using a custom provider, you must specify the `model` explicitly." and :203 "`model?: string` … **Required when using custom provider.**"

## Q2. Exact config fields we use
```ts
// CopilotClientOptions (types.d.ts:250)
new CopilotClient({
  useLoggedInUser: false,      // :322 "When false, only explicit tokens (gitHubToken or environment variables) are used."
  baseDirectory: '<repo>/artifacts/tmp/copilot-home', // :280 "Sets the COPILOT_HOME environment variable on the spawned runtime."
});
// SessionConfig
client.createSession({
  model: process.env.TRANCHE_LLM_MODEL,                      // required with provider
  provider: { type: 'openai' | 'anthropic' | 'azure', baseUrl, apiKey },
  tools: [defineTool('schedule_shift_preview', {...})],       // defineTool: types.d.ts:594
  availableTools: new ToolSet().addCustom('schedule_shift_preview'),
  onPermissionRequest: () => ({ kind: 'reject', ... }),
});
```
Implemented in `hackathon_paypal_bryntum/src/agent/spikeAgent.ts` (`byokProviderFromEnv`, `buildSessionConfig`, `runSpike`).
Env: `TRANCHE_LLM_PROVIDER`, `TRANCHE_LLM_BASE_URL` (defaults: openai → https://api.openai.com/v1, anthropic → https://api.anthropic.com), `TRANCHE_LLM_API_KEY`, `TRANCHE_LLM_MODEL`, `TRANCHE_AZURE_API_VERSION`.

Other relevant fields: `gitHubToken?: string` (:315, "This takes priority over other authentication methods."), `onListModels?` (:329, "Useful in BYOK mode to return models available from your custom provider.").

## Q3. Does it still need the Copilot CLI binary or a GitHub login?
- **No separate CLI install.** The SDK ships its runtime as a per-platform optionalDependency: `package.json` → `optionalDependencies: { "@github/copilot-sdk-darwin-arm64": "1.0.15", "@github/copilot-sdk-darwin-x64": …, "@github/copilot-sdk-linux-x64": …, "@github/copilot-sdk-win32-x64": … }`. `node_modules/@github/copilot-sdk-darwin-x64/package.json`: "Platform runtime for @github/copilot-sdk (darwin-x64)" (126 MB). `types.d.ts:102` "Path to the runtime executable. When omitted, the bundled runtime is used." `npm install` is enough.
- **No GitHub login with BYOK** — verified (below). Requires Node `^20.19.0 || >=22.12.0` (SDK `engines`).

## Q4. Local experiments (no real key used; nothing secret printed or stored)
All with `env -u GH_TOKEN -u GITHUB_TOKEN -u COPILOT_GITHUB_TOKEN`, `useLoggedInUser: false`, isolated `COPILOT_HOME`.

1. Fake keys → the request reaches the provider and fails with the provider's 401 (`artifacts/logs/byok-fake-key-probe.txt`):
```
### provider=openai fake key, GitHub token env unset, useLoggedInUser=false, isolated COPILOT_HOME (2026-10-17T19:38:56Z)
SPIKE_FAILED Authentication failed with provider at https://api.openai.com/v1 (HTTP 401).
  Check your COPILOT_PROVIDER_API_KEY, COPILOT_PROVIDER_API_KEY_COMMAND, or COPILOT_PROVIDER_BEARER_TOKEN.
### provider=anthropic fake key, ... (2026-10-17T19:38:59Z)
SPIKE_FAILED Authentication failed with provider at https://api.anthropic.com (HTTP 401).
```
   (The runtime error also reveals env-var alternatives `COPILOT_PROVIDER_API_KEY`, `COPILOT_PROVIDER_API_KEY_COMMAND`, `COPILOT_PROVIDER_BEARER_TOKEN`.)
2. **Full successful BYOK run with zero keys and zero GitHub auth** — local Ollama (`provider: { type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' }`, model `qwen3:4b-instruct`): the model called `schedule_shift_preview` with `{"invoice_number":"INV-2","reason":"overdue 9 days"}` and summarised the result; 1 user turn, 2 model requests, 140.8 s on CPU (`artifacts/logs/agent-run-byok-2026-10-17T19-44-30-537Z.json`). First attempt hit our 120 s timeout; the timeout is now `TRANCHE_TIMEOUT_MS`.

## Judge path conclusion
- Default (no key at all): **mock mode** — the board plus a deterministic "scripted agent" fallback so judges see the full flow without any LLM.
- With their own key: `TRANCHE_LLM_PROVIDER=openai TRANCHE_LLM_API_KEY=... TRANCHE_LLM_MODEL=gpt-4o-mini npm start` (or anthropic/azure) — no Copilot subscription, no GitHub login, no CLI.
- With a Copilot subscription: the already-logged-in user (as we used: `copilot-login:yuxinshiu63`, model `gpt-6-luna`).

## UNVERIFIED
- A real OpenAI/Anthropic/Azure key end-to-end (we only proved the 401 path + a keyless local provider).
- Whether Azure needs `wireApi: "responses"` for newer deployments.
- Windows/Linux runtime packages (only darwin-x64 exercised).
