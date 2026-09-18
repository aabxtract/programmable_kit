# Programmable DevKit — Build Guide

A TypeScript SDK + MCP Server for the [Programmable Market](https://programmable.market)
API, defaulting to Robinhood Chain (chainId 4663).

> ✅ **Endpoints are validated, not inferred.**
> Every route was checked against the live platform on 2026-09-17, using the discovery
> manifest, the [v2 OpenAPI spec](https://developers.programmable.family/openapi/programmable-v2.yaml),
> and the [v4 custom-launch spec](https://programmable.market/openapi/custom-launch-v4.json).
> Run `npm run check` to re-verify at any time.
>
> Three features named in earlier drafts of this guide **do not exist** in the public
> API. They are handled explicitly rather than silently — see
> [§11 What isn't available](#11-what-isnt-available).

---

## Repo Structure

```
programmable-devkit/
├── package.json              # npm workspaces root + check scripts
├── tsconfig.base.json        # Shared compiler options
├── tsconfig.scripts.json     # Build config for scripts/
├── .gitignore                # Contains `.env`
├── .env.example
├── packages/
│   ├── sdk/                  # @programmable-devkit/sdk — zero runtime deps
│   │   └── src/
│   │       ├── index.ts      # ProgrammableClient + createClient(FromManifest)
│   │       ├── types.ts      # Types, constants, and ENDPOINTS
│   │       ├── http.ts       # Fetch wrapper + the error taxonomy
│   │       ├── launches.ts   # LaunchesClient
│   │       ├── modules.ts    # ModulesClient (derived — see §11)
│   │       ├── verify.ts     # VerifyClient
│   │       └── discovery.ts  # DiscoveryClient
│   ├── mcp-server/           # @programmable-devkit/mcp-server
│   │   └── src/index.ts      # All 9 MCP tools
│   └── create-programmable-hook/   # CLI scaffolder + guardrail checker
│       └── BUILD_GUIDE.md    # Its own guide — see that file
├── scripts/
│   ├── smoke.ts              # Probes every endpoint, reports pass/fail/degraded
│   ├── mcp-check.ts          # Drives the MCP server over stdio end-to-end
│   └── hook-check.ts         # Scaffolds templates + proves the checker catches violations
└── .git-hooks/
    └── pre-commit            # Key leak guard
```

This guide covers the **SDK and MCP server**. The hook scaffolder has its own guide at
[`packages/create-programmable-hook/BUILD_GUIDE.md`](packages/create-programmable-hook/BUILD_GUIDE.md),
and [`README.md`](README.md) indexes all three packages.

---

## 1. Prerequisites

- **Node.js ≥ 20.6** — 20.6 is the floor, not 20.0. [§3](#3-secrets--safety) uses
  `--env-file`, which landed in 20.6.
- npm ≥ 10 (for workspaces)
- An API key from [programmable.market/developers/api-keys](https://programmable.market/developers/api-keys)
  — **only needed for two of the nine MCP tools**. Everything else is public.

---

## 2. Install dependencies

```bash
npm install
```

---

## 3. Secrets & safety

Programmable's own v4 spec says the key must be read "only from `PROGRAMMABLE_API_KEY`
or an approved encrypted secret store" and is "never accepted in a request body or CLI
flag." Three things enforce that. Do all three.

### 3.1 Ignore the env file — actually ignore it

```bash
echo ".env" >> .gitignore
```

A `# add to .gitignore` comment *inside* `.env` does nothing. The line has to be in
`.gitignore` itself.

### 3.2 Install the pre-commit guard

```bash
git config core.hooksPath .git-hooks
```

Prefer this over `cp .git-hooks/pre-commit .git/hooks/`. A copied hook lives in `.git/`,
which is never cloned — every new contributor silently loses the guard. `core.hooksPath`
points git at the version-controlled directory, so the hook travels with the repo.

It blocks three things, verified working:

| Staged content | Result |
|---|---|
| `PROGRAMMABLE_API_KEY=pm_live_9f3ka82...` | blocked |
| `PROGRAMMABLE_API_KEY=your_key_here` | allowed (placeholder) |
| A `0x…` 64-hex wallet private key | blocked |
| Any `.env` file (except `.env.example`) | blocked |

Bypass with `git commit --no-verify` when you're sure.

### 3.3 Create your `.env`

```bash
cp .env.example .env
# then fill in PROGRAMMABLE_API_KEY
```

Load it with Node's built-in flag rather than shell tricks:

```bash
node --env-file=.env packages/mcp-server/dist/index.js
```

Do **not** use `export $(cat .env | xargs)`. It word-splits on spaces, mangles `#`,
breaks on quoted values, and exports the key into your shell history and every child
process you subsequently run.

The SDK throws if the key is set but empty. It never silently falls back.

---

## 4. Build everything

```bash
npm run build
```

---

## 5. Verify your install

```bash
npm run check        # smoke + mcp-check + hook-check
npm run smoke        # endpoints only
npm run check:mcp    # MCP server only
npm run check:hook   # hook templates + checker regression
```

`smoke.ts` calls every endpoint and reports one line each:

```
  discovery : https://programmable.market
  api       : https://developers.programmable.family
  custom    : https://api.programmable.market
  chain     : 1

  PASS discovery.getManifest()          schema 2.0.0, 2 chains
  PASS discovery.getStatus()            service degraded
  PASS discovery.getSubmissionStatus()  api create open, legacy closed
  PASS launches.listPage()              2 items, feed degraded
  PASS launches.getByAddress()          SHARD
  n/a  launches.getStockPaired()        unsupported by design
  PASS modules.list()  [derived]        2 distinct models
  PASS verify.verifyToken()             sourceMatch unavailable
  PASS launches.listCustomLaunches()    5 launches
  PASS launches.getStatus()             status failed

9 passed, 0 failed, 0 degraded (9 checks)
```

With `--key`, the authenticated checks discover a real launch id from your account and
use it, rather than probing with a sentinel — that validates the response shape, not
just that auth is accepted.

The three outcomes mean different things, and the distinction is the point:

- **FAIL** — a path or response shape is wrong. Fix `ENDPOINTS` in
  `packages/sdk/src/types.ts`. Exits non-zero.
- **WARN** — the platform answered 429/5xx, or the socket dropped. A service condition,
  not your bug. Rerun later. Does not fail the run.
- **n/a** — the operation is unsupported by design ([§11](#11-what-isnt-available)).

Options: `--chain <id>` (default 4663), `--key` to include the authenticated endpoints,
`--base-url <url>` to point elsewhere.

> **Robinhood Chain is currently `unavailable`** in the platform's read model, so
> `npm run smoke` with no arguments reports 2 WARNs and no failures. Use
> `npm run smoke -- --chain 1` to exercise every check against live data.

`mcp-check.ts` spawns the built server over stdio, completes the MCP handshake, asserts
all 9 tools are advertised, and calls them (including the authenticated ones when a
key is present). It catches integration
bugs the type checker can't — it's how the `capabilities[]` shape error was found.

---

## 6. Use the SDK

```typescript
import { createClient } from "@programmable-devkit/sdk";

// Key from PROGRAMMABLE_API_KEY; chain defaults to 4663
const client = createClient();

// Or let the platform's own manifest configure the origins
// const client = await createClientFromManifest();

// A page of launches, with the envelope intact
const feed = await client.launches.listPage({ chainId: 1, limit: 10 });
console.log(feed.status, feed.items.length, feed.page?.hasMore);

// Just the records
const recent = await client.launches.getRecent(10);

// One launch by token address
const shard = await client.launches.getByAddress(
  "0xFAce73B63787960282f2d4682d3752Beb25271Ad",
  { chainId: 1 },
);
console.log(shard.token?.symbol); // "SHARD"

// Verification, read off the launch record
const verified = await client.verify.verifyToken("0x...", { chainId: 1 });
console.log(verified.sourceMatch);
// "queued" | "retrying" | "exact_match" | "needs_attention" | "unavailable"

// Submission gate, before spending quota on a submission flow
const gate = await client.discovery.getSubmissionStatus();
if (!gate.apiCreateOpen) {
  console.error("API create gate is closed");
  process.exit(1);
}
```

### Always check `feed.status`

```typescript
const feed = await client.launches.listPage({ chainId: 4663 });

if (feed.status !== "live") {
  // The API is explicit: coverage gaps do not hide recognized records, but absence
  // is not authoritative while degraded. An empty page is not proof of nothing.
  console.warn(`Feed is ${feed.status} — absence proves nothing here.`);
}
```

This is the single most common way to get a wrong answer out of this API. The records
you get back are real; the ones you don't get back may also be real.

### Handling errors

The taxonomy exists so you can tell *fix my code* from *wait and retry*:

| Error | Means | Do |
|---|---|---|
| `ProgrammableHttpError` | Got an HTTP response, non-2xx | Check `.status`, `.isTransient`, `.retryAfterMs` |
| `ProgrammableNetworkError` | No response at all — socket dropped, DNS | Retry |
| `ProgrammableTimeoutError` | Exceeded your deadline | Retry or raise `timeoutMs` |
| `ProgrammableResponseError` | 2xx with an unusable body | Fix the SDK; `.reason` is `content-type` or `shape` |
| `ProgrammableUnsupportedError` | Not served by the public API, permanently | Stop asking ([§11](#11-what-isnt-available)) |
| `ProgrammableAuthError` | Authenticated route, no key | Set `PROGRAMMABLE_API_KEY` |
| `ProgrammableActionRequiredError` | Launch is waiting on you | Resolve `.failure.code` |
| `ProgrammableLaunchFailedError` | Launch is terminally failed | Read `.failure` |
| `ProgrammableConfigError` | Bad option, empty key | Fix the call |

`ProgrammableHttpError` parses the platform's error envelope
(`{ error: { code, message, requestId } }`) into `.code` and `.requestId`, so you get
`UNAUTHENTICATED` or `NOT_FOUND` directly rather than having to dig through `.body`.
Quote `.requestId` in support reports.

```typescript
import { ProgrammableHttpError, ProgrammableNetworkError } from "@programmable-devkit/sdk";

try {
  const launch = await client.launches.getByAddress("0x...", { chainId: 4663 });
} catch (err) {
  if (err instanceof ProgrammableHttpError) {
    if (err.status === 503) {
      // NOT "the token is missing". While the read model is degraded the API answers
      // 503 rather than confirm absence. Retry; don't record a negative result.
    }
    if (err.isTransient) await backOff(err.retryAfterMs ?? 5000);
  } else if (err instanceof ProgrammableNetworkError) {
    await backOff(5000); // never reached the server
  } else {
    throw err;
  }
}
```

### Working with custom launches

Everything in the v4 flow needs a launch id, so start by listing yours:

```typescript
const page = await client.launches.listCustomLaunches({ limit: 10 });
for (const launch of page.launches) {
  console.log(launch.launchId, launch.status, launch.failure?.code ?? "-");
}
// d55f425b-…  failed           PERMIT_EXPIRED
// 994fcdf5-…  action_required  SOURCE_LIQUIDITY_LOCK_OR_CUSTODY_SURFACE
// 9cffeaca-…  received         -
```

A `failure` on an `action_required` launch describes **what to fix**, not a dead launch.
Only `failed` is terminal.

> ⚠️ **Two v4 quirks.** It returns `chainId` as a **string** (`"4663"`), unlike the v2
> read API which returns a number — `CustomLaunchStatus.chainId` is typed
> `string | number`, so don't `===` it against a numeric literal. And the v4 API serves
> **chain 4663 only**: any other chain returns 400 `CUSTOM_LAUNCH_CHAIN_MISMATCH`
> ("V4 path chainId must be 4663"). The SDK rejects those calls locally with a
> `ProgrammableConfigError` rather than spending a request. Ethereum custom launches
> use the separate v3 API, which this SDK doesn't cover yet.

Then poll one:

```typescript
const result = await client.launches.watchUntil("launch-id", "authorized", {
  intervalMs: 5_000,   // default, floor 1_000
  timeoutMs: 300_000,  // default — throws ProgrammableTimeoutError on expiry
  onPoll: (status, n) => console.log(`poll ${n}: ${status.status}`),
});
console.log("Wallet handoff URL:", result.walletHandoffUrl);
```

`watchUntil` stops early on `action_required` and `wallet_action_required` with
`ProgrammableActionRequiredError`, carrying the server's failure code. Those states
cannot advance without you doing something out of band, so polling to the deadline would
just bury the reason under a timeout. Pass `{ waitThroughActionRequired: true }` if
something outside your process will resolve it.

Real lifecycle states, from the v4 spec:

```
received → validating → action_required → authorized →
awaiting_wallet_signature → wallet_action_required → submitted →
sequencer_soft_confirmed → ethereum_posted → finalized
                                                  failed (terminal)
```

`authorized` is when `walletHandoffUrl` becomes available — that's the state to wait for
before handing off to signing. Polling costs one request per interval; worst case is
`timeoutMs / intervalMs` calls. A launch that reaches `failed` throws
`ProgrammableLaunchFailedError` carrying the server's `failure.code` and `.retryable`,
so a stuck launch surfaces as an error instead of burning quota until timeout.

---

## 7. Rate limits & retries

The SDK does not retry by default. You own the policy.

- **429 handling.** `ProgrammableHttpError.isRateLimited` is true; `retryAfterMs` is
  populated from `Retry-After` when the server sends it. Back off exponentially when it
  doesn't.
- **503 is not 404.** On point lookups the platform answers 503 rather than confirm a
  token is absent while degraded. Treat it as *unknown*, never as *does not exist*.
- **`isTransient`** covers 429 and all 5xx. `ProgrammableNetworkError.isTransient` is
  always true.
- **Quota-aware ordering.** Call `discovery.getSubmissionStatus()` before a submission
  flow. One cheap request saves a wasted expensive one.
- **Pagination.** `listAll()` follows `page.nextCursor` and stops at 20 pages by default.
  Each page is one request. Persist `page.resumeCursor` after a completed poll and pass
  it back as `after` next time — `after` and `cursor` must never be sent together.
- **Exact limits are not published.** Revise these defaults once you observe real 429s.

---

## 8. Run the MCP Server

### Local development (before publishing)

```json
{
  "mcpServers": {
    "programmable": {
      "command": "node",
      "args": ["/absolute/path/to/programmable-devkit/packages/mcp-server/dist/index.js"],
      "env": {
        "PROGRAMMABLE_API_KEY": "${env:PROGRAMMABLE_API_KEY}"
      }
    }
  }
}
```

Or directly: `npm start -w packages/mcp-server`

### After publishing

Same block, with `"command": "npx"` and
`"args": ["@programmable-devkit/mcp-server"]`.

> 🔑 **Don't inline the key.** `${env:PROGRAMMABLE_API_KEY}` reads from your environment
> at launch. Project-scoped MCP configs (`.cursor/mcp.json`, `.mcp.json`) are routinely
> committed — pasting the raw key there defeats the pre-commit guard from
> [§3](#3-secrets--safety) and is the most common way these keys leak.

### Environment

| Var | Purpose |
|---|---|
| `PROGRAMMABLE_API_KEY` | Bearer key for the two authenticated tools. Optional. |
| `PROGRAMMABLE_CHAIN_ID` | Default chain. Defaults to `4663`. |
| `PROGRAMMABLE_BASE_URL` | Override the public read API origin. |

### Available MCP Tools

| Tool | Auth needed | What it does |
|------|-------------|--------------|
| `list_launches` | No | Launch feed; returns `feedStatus` + a degraded-coverage caveat |
| `get_launch` | No | Single launch by token address + chain |
| `get_stock_paired_launches` | No | **Reports itself unsupported** — see §11 |
| `list_modules` | No | **Derived** from launch records — see §11 |
| `get_modules_by_family` | No | **Derived**; matches model ids and capability ids |
| `verify_token` | No | Verification read off the launch record |
| `check_submission_gate` | No | API create gate, separate from legacy intake |
| `list_custom_launches` | **Yes** | Your launches + status. How you discover launch ids |
| `get_launch_status` | **Yes** | v4 lifecycle + `walletHandoffUrl` |

Every tool result is shaped for a model reading it: errors explain whether to retry,
fix a path, or stop asking, and list results carry an explicit note that absence is not
authoritative while the feed is degraded.

---

## 9. Publishing to npm

**Order matters.** `mcp-server` depends on `sdk`. Publishing in the wrong order ships an
`mcp-server` whose dependency version doesn't exist on the registry yet.

```bash
npm login
npm run build
npm run check          # don't publish something that can't reach the API
```

**1.** `npm publish -w packages/sdk --access public`

**2.** Pin the dependency in `packages/mcp-server/package.json` to the version you just
published:

```json
"dependencies": { "@programmable-devkit/sdk": "^0.1.0" }
```

**3.** `npm publish -w packages/mcp-server --access public`

`--access public` is required — scoped packages default to restricted.

You don't own the `@programmable` namespace — publish under `@programmable-devkit` or
your own scope until Programmable officially adopts the kit.

---

## 10. What the APIs map to

The platform spans three origins. That's why there isn't a single `baseUrl`. The v2
read API is multi-chain; the v4 custom-launch API is Robinhood-only.

| Origin | Host | Auth |
|---|---|---|
| Discovery | `programmable.market` | none |
| Public read API (v2) | `developers.programmable.family` | none |
| Custom launch API (v4) | `api.programmable.market` | Bearer key |

| SDK method | Endpoint | Origin |
|---|---|---|
| `discovery.getManifest()` | `/.well-known/programmable.json` | discovery |
| `discovery.getStatus()` | `/api/v2/status` | api |
| `discovery.getSubmissionStatus()` | manifest `publicCategories.custom` | discovery |
| `launches.listPage()` / `list()` / `listAll()` | `/api/v2/launches` | api |
| `launches.getByAddress()` | `/api/v2/launches/{chainId}/{tokenAddress}` | api |
| `launches.getById()` | `/api/v2/launches/{launchId}` | api |
| `launches.listCustomLaunches()` | `/v4/chains/4663/custom-launches` | customLaunch |
| `launches.getStatus()` | `/v4/chains/4663/custom-launches/{launchId}` | customLaunch |
| `verify.verifyToken()` | launch `extensions["programmable/backend-finalized-v4"]` | api |
| `modules.list()` | derived from `/api/v2/launches` | api |

Rather than hardcoding these, prefer `createClientFromManifest()`. The manifest exists
precisely so that "new EVM chains and Registry generations are added here so clients do
not need a code change."

---

## 11. What isn't available

Three things this guide originally specified have no backing API. Each is handled
explicitly, because a confident wrong answer is worse than a clear refusal.

### Stock-paired launches — permanently unavailable

The v2 spec states: *"Stock-Paired launches are excluded from active API v2 Developer
discovery and scanning."* No endpoint exposes the equity pairing, and no launch record
carries a ticker field. The frozen v1 compatibility snapshot doesn't either.

`launches.getStockPaired()` throws `ProgrammableUnsupportedError`. It does **not** return
`[]`, because an empty array reads as "no NVDA tokens exist" when the truth is "this API
will not tell you."

### Modules — no endpoint; derived instead

`/api/v2/modules` returns 404, and neither OpenAPI spec defines a module registry.
Modules are a website concept, not an API resource.

`ModulesClient` therefore derives them from what launches actually declare on chain —
`model: { id, version }` and `capabilities[]`. That's real, verifiable data, but it's a
projection of observed launches: **a module nobody has launched with will not appear.**
The platform also has no "family" level; `getByFamily()` matches model ids and capability
ids case-insensitively.

### Source verification — no standalone endpoint

`/docs/developers/verify` is a documentation page that returns HTML. Verification is
published *on the launch record*, at
`extensions["programmable/backend-finalized-v4"].sourceVerification`, so `VerifyClient`
reads a launch and projects that field.

The verdict vocabulary is **not** `exact_match | partial_match | unverified`. It is:

```
queued | retrying | exact_match | needs_attention   (+ "unavailable", this SDK's value
                                                     for "no verdict published yet")
```

There is no "partial match". Per the spec, *"Blockscout observations alone never
establish an exact match"* — only a durable Sourcify V2 exact result qualifies, and
anything short of it lands in `needs_attention`.

---

## 12. Next steps

1. ~~`create-programmable-hook` CLI scaffolder~~ — built, see
   [its guide](packages/create-programmable-hook/BUILD_GUIDE.md)
2. ~~Local pre-submission checker~~ — built as `programmable-check`, 7 hard blocks
   grounded in the live manifest invariants
3. Hook-aware discovery UI in Next.js 16
4. Wire up the v4 write path — `POST /v4/chains/{chainId}/custom-launches/preflight`
   and `POST .../custom-launches`. The SDK currently covers reads only; the create flow
   needs funding plans, commitment digests, and wallet handoff.
