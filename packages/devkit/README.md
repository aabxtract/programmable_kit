# programmable-devkit

One command for [Programmable Market](https://programmable.market) on Robinhood Chain:
scaffold a Uniswap v4 hook, check it against the live admission invariants, and run the
MCP server.

```bash
npm install -g programmable-devkit
programmable new my-hook --template creator-fee-hook --fee 3000 --symbol MYT
```

## What you get

The scaffolded project **depends on** `@aabxtract/programmable-sdk` and is **already wired**
to your agent. The SDK and MCP server are dependencies, not copied source — they update
with `npm install` rather than going stale in your repo.

```
my-hook/
├── src/CreatorFeeHook.sol          checked before the command returns
├── programmable-launch.config.json --fee 3000 already substituted
├── package.json                    depends on @aabxtract/programmable-sdk
├── .mcp.json                       MCP tools for Claude Code / Cursor / Windsurf
├── AGENTS.md                       compiler pin, 14 bits, return shapes
├── foundry.toml                    solc pinned to the platform toolchain
├── .git-hooks/pre-commit           key leak guard
└── scripts/
    ├── watch-launch.mjs            wait for `authorized`, print the sign URL
    └── capabilities.mjs            read the live profileDigest
```

## Commands

| Command | Does |
|---|---|
| `programmable new <name>` | Scaffold, substitute values, check the output |
| `programmable check [path]` | Run the 7 hard blocks locally (default `./src`) |
| `programmable doctor` | Key, API reachability, submission gate, your launches |
| `programmable profile` | Pinned compiler, permission bits, invariants |
| `programmable mcp` | Run the MCP server on stdio |
| `programmable templates` | Templates as JSON, for tooling |

### Templates

```bash
programmable new my-hook --template buyback-hook \
  --name "My Token" --symbol MYT --treasury 0x… --bps 100

programmable new fees --template creator-fee-hook \
  --name "Creator Coin" --symbol CRTR --fee 3000
```

`--fee` is in pips (hundredths of a bip): `3000` = 0.30%. Values are validated before
anything is written — `--fee 0.3%` is rejected rather than landing in a config file.
Anything you don't supply stays `TODO` in the config, and the command tells you what's
left.

### Doctor

```
  PASS submission gate    api create OPEN
  PASS launch feed        unavailable  (absence is not authoritative while degraded)
  PASS authenticated      5 custom launch(es)
       994fcdf5-b23f-4569-9…  action_required  SOURCE_LIQUIDITY_LOCK_OR_CUSTODY_SURFACE
```

Checks in the order that matters: is the gate open, is the platform up, is your key
working — each answer changes whether the next one matters.

## Why check locally

A custom launch request is **immutable**. A rejected submission burns the attempt and
you only find out afterwards. `programmable check` runs the platform's own admission
invariants against your source first; exit 0 means nothing would hard-block.

Every rule is grounded in the live contract manifest, not inferred. See
`programmable profile`.

## Secrets

`PROGRAMMABLE_API_KEY` goes in `.env`, loaded with `node --env-file=.env`, or exported so
`.mcp.json` can expand it. Never inline it in `.mcp.json` — that file gets committed.

---

Unofficial. Not affiliated with or endorsed by Programmable.
