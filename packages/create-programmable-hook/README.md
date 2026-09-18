# create-programmable-hook

Scaffold Uniswap v4 hooks for [Programmable Market](https://programmable.market), and
check them against the platform's admission invariants **before** you submit.

```bash
npx create-programmable-hook my-hook
npx programmable-check ./my-hook/src/
```

A custom launch request is immutable. A rejected submission burns the attempt and you
only find out afterwards. This catches the seven hard blocks locally first.

## Scaffold

```bash
npx create-programmable-hook my-hook                            # buyback-hook
npx create-programmable-hook my-hook --template creator-fee-hook
npx create-programmable-hook --list
```

You get a contract pinned to `0.8.26` with PoolManager auth on every effectful callback
and permissions matched to implementations, plus `foundry.toml`, `remappings.txt`, a key
leak guard, a filled-in launch config, and an `AGENTS.md` your AI assistant reads
automatically. The scaffolder checks its own output before it finishes.

## Check

```bash
npx programmable-check ./src/           # exit 0 = nothing would hard-block
npx programmable-check ./src/ --json
npx programmable-check --show-profile   # the pinned compiler, bits, and invariants
```

| Hard block | Condition |
|---|---|
| HC-001 | `callcode` in source |
| HC-002 | `selfdestruct` in source |
| HC-003 | Effectful callback with no PoolManager check |
| HC-004 | Hardcoded PoolManager address |
| HC-005 | Permissions and implementations disagree |
| HC-006 | Callback returns the wrong number of values |
| HC-007 | Reserved `platform:` action id |

Plus soft warnings for `delegatecall`, a non-pinned pragma, ownership/pause controls,
and mint functions — each a disclosure obligation, none of which fail the run.

Comments and strings are stripped before scanning, and revert-only stubs are recognised
as stubs, so correct hooks don't get flagged.

## Programmatic use

```typescript
import { checkPath, scaffold } from "create-programmable-hook";

const result = await checkPath("./src");
if (!result.ok) console.error(result.findings);
```

Every rule is grounded in the platform's live manifest, not inferred. Full docs:
[BUILD_GUIDE.md](BUILD_GUIDE.md).
