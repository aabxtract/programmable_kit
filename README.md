# Programmable DevKit

An unofficial developer kit for [Programmable Market](https://programmable.market) on
Robinhood Chain (chainId 4663): a typed SDK, an MCP server, and a hook scaffolder with a
local admission checker.

## One command

```bash
npm install -g programmable-devkit
programmable new my-hook --template creator-fee-hook --fee 3000 --symbol MYT
```

That scaffolds a project which **depends on** the SDK and is **already wired** to your
agent — `.mcp.json` for the MCP tools, `AGENTS.md` for the constraints. The SDK and MCP
server are dependencies, not copied source, so they update with `npm install` instead of
going stale in your repo.

```
my-hook/
├── src/CreatorFeeHook.sol          checked before the command returns
├── programmable-launch.config.json --fee 3000 already substituted
├── package.json                    depends on @programmable-devkit/sdk
├── .mcp.json                       Programmable tools for Claude Code / Cursor
├── AGENTS.md                       compiler pin, 14 bits, return shapes
└── scripts/
    ├── watch-launch.mjs            wait for `authorized`, print the sign URL
    └── capabilities.mjs            read the live profileDigest
```

| Command | Does |
|---|---|
| `programmable new <name>` | Scaffold, substitute values, check the output |
| `programmable check [path]` | Run the 7 hard blocks locally |
| `programmable doctor` | Key, API reachability, submission gate, your launches |
| `programmable profile` | Pinned compiler, permission bits, invariants |
| `programmable mcp` | Run the MCP server on stdio |

`npx create-programmable-hook my-hook` still works if you'd rather not install globally.

## Layout

One monorepo, four packages. They share a toolchain and release together rather than
drifting apart in separate repos.

```
programmable-devkit/
├── packages/
│   ├── sdk/                        @programmable-devkit/sdk
│   ├── mcp-server/                 @programmable-devkit/mcp-server
│   ├── create-programmable-hook/   create-programmable-hook
│   └── devkit/                     programmable-devkit  (the `programmable` command)
├── scripts/                        smoke.ts · mcp-check.ts · hook-check.ts
└── .git-hooks/pre-commit           key leak guard
```

| Package | What it is | Guide |
|---|---|---|
| [`@programmable-devkit/sdk`](packages/sdk) | Typed client for the v2 read API and the v4 custom-launch API. Zero runtime deps. | [BUILD_GUIDE.md](BUILD_GUIDE.md) |
| [`@programmable-devkit/mcp-server`](packages/mcp-server) | 9 MCP tools for Claude Code, Cursor, Windsurf. | [BUILD_GUIDE.md](BUILD_GUIDE.md) |
| [`create-programmable-hook`](packages/create-programmable-hook) | Scaffolds v4 hooks; `programmable-check` catches admission blockers locally. | [packages/create-programmable-hook/BUILD_GUIDE.md](packages/create-programmable-hook/BUILD_GUIDE.md) |
| [`programmable-devkit`](packages/devkit) | Meta-package. One global install, the `programmable` command. | this file |

## Developing this repo

```bash
npm install
npm run build
npm run check          # smoke + mcp-check + hook-check
```

```typescript
import { createClient } from "@programmable-devkit/sdk";

const client = createClient();
const feed = await client.launches.listPage({ limit: 10 });
console.log(feed.status, feed.items.length);
```

## Why these three ship together

The kit exists to move feedback earlier than the platform does:

- **`create-programmable-hook`** catches the seven admission hard-blocks *before* you
  submit. A custom launch request is immutable — a rejection burns the attempt.
- **`sdk`** watches the lifecycle afterwards, and knows that `action_required` means the
  launch is waiting on you rather than on the server.
- **`mcp-server`** puts both in reach of an AI assistant, with tool descriptions that
  say when a result is authoritative and when it isn't.

Every constant in the kit — the pinned compiler, the 14 permission bits, the invariant
texts, the lifecycle states — was read from the platform's live manifest, not inferred.
`npm run check` re-verifies against production at any time.

## Verification

| Command | Proves |
|---|---|
| `npm run smoke` | Every endpoint responds and the SDK parses it. `-- --key` includes the authenticated routes. |
| `npm run check:mcp` | The MCP server handshakes and all 9 tools return usable results. |
| `npm run check:hook` | Templates scaffold clean **and** the checker actually catches violations. |

## Secrets

`PROGRAMMABLE_API_KEY` goes in `.env` (gitignored), loaded with `node --env-file=.env`.
Install the leak guard once:

```bash
git config core.hooksPath .git-hooks
```

It blocks staged `.env` files, real-looking API keys, and `0x…` private keys. See
[BUILD_GUIDE.md §3](BUILD_GUIDE.md#3-secrets--safety).

## Status

Unofficial. Not affiliated with or endorsed by Programmable. The `@programmable`
namespace is not ours — packages publish under `@programmable-devkit`.

npm names checked 2026-09-18: `create-programmable-hook`, `programmable-devkit`,
`programmable-check` and the `@programmable-devkit/*` scope are all free. Bare
`programmable` is taken (v1.0.5), which is why the meta-package is `programmable-devkit`
even though its binary is `programmable`.
