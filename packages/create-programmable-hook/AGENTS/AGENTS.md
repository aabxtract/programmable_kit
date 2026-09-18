# AGENTS.md — Programmable v4 hook constraints

Machine-readable constraints for AI coding assistants working in this project.
Everything here was read from the platform's live manifest, not inferred.

Source: `GET https://api.programmable.market/v4/chains/4663/custom-launch-contract/manifest.json`
and `GET /v4/chains/4663/capabilities`. Verified 2026-09-17.
Re-check anytime with `npx programmable-check --show-profile`.

---

## The one thing that matters

**A custom launch request is immutable.** A rejected submission burns the attempt. Every
rule below exists because breaking it causes `action_required` at submission, after the
request is already spent. Run `npx programmable-check ./src/` before submitting — always.

---

## Compiler

```
solc 0.8.26+commit.8a97fa7a
```

Write `pragma solidity 0.8.26;` — exact, **no caret**. A floating pragma changes the
compiled runtime hash, which breaks the `runtime_binding` invariant ("Declared, compiled
and observed critical runtime hashes agree").

Size limits: runtime ≤ 24576 bytes, init code ≤ 49152 bytes.

---

## PoolManager binding

Never hardcode a PoolManager address. Inject it and hold it immutable:

```solidity
IPoolManager public immutable poolManager;

constructor(IPoolManager _poolManager) {
    if (address(_poolManager) == address(0)) revert InvalidPoolManager();
    poolManager = _poolManager;
}
```

The platform binds the PoolManager itself. A literal address in source fails
`source_binding`.

---

## Callback authorization

Invariant `callback_authority`: *"Effectful callbacks reject callers other than the bound
PoolManager."*

Every callback that does anything must guard:

```solidity
modifier onlyPoolManager() {
    if (msg.sender != address(poolManager)) revert NotPoolManager();
    _;
}
```

Revert-only stubs for disabled callbacks don't need a guard — they have no effect.

---

## Permission bits

Invariant `hook_permissions`: *"All 14 address permission bits and return-delta
dependencies agree with the declaration."*

Bit positions are fixed by the platform. They are encoded in the hook's **deployed
address**, so they must agree three ways: address bits ↔ `getHookPermissions()` ↔
implemented functions.

| Bit | Name | Has a function? |
|----|------|----|
| 13 | `beforeInitialize` | yes |
| 12 | `afterInitialize` | yes |
| 11 | `beforeAddLiquidity` | yes |
| 10 | `afterAddLiquidity` | yes |
| 9 | `beforeRemoveLiquidity` | yes |
| 8 | `afterRemoveLiquidity` | yes |
| 7 | `beforeSwap` | yes |
| 6 | `afterSwap` | yes |
| 5 | `beforeDonate` | yes |
| 4 | `afterDonate` | yes |
| 3 | `beforeSwapReturnDelta` | **no — flag only** |
| 2 | `afterSwapReturnDelta` | **no — flag only** |
| 1 | `afterAddLiquidityReturnDelta` | **no — flag only** |
| 0 | `afterRemoveLiquidityReturnDelta` | **no — flag only** |

The bottom four are flags, not callbacks. Do **not** write a
`beforeSwapReturnDelta()` function. Each requires its parent callback enabled:

- `beforeSwapReturnDelta` → needs `beforeSwap`
- `afterSwapReturnDelta` → needs `afterSwap`
- `afterAddLiquidityReturnDelta` → needs `afterAddLiquidity`
- `afterRemoveLiquidityReturnDelta` → needs `afterRemoveLiquidity`

---

## Callback return shapes

Invariant `callback_abi`: *"Enabled callbacks have the exact required selector and return
shape."*

```
beforeInitialize      -> (bytes4)
afterInitialize       -> (bytes4)
beforeAddLiquidity    -> (bytes4)
afterAddLiquidity     -> (bytes4, BalanceDelta)
beforeRemoveLiquidity -> (bytes4)
afterRemoveLiquidity  -> (bytes4, BalanceDelta)
beforeSwap            -> (bytes4, BeforeSwapDelta, uint24)
afterSwap             -> (bytes4, int128)
beforeDonate          -> (bytes4)
afterDonate           -> (bytes4)
```

Return the matching `IHooks.<name>.selector`. Returning a non-zero delta without the
corresponding return-delta bit enabled is a mismatch.

---

## Reserved to the platform

Invariant `platform_authority`. The action id prefix `platform:` is reserved. The
platform appends exactly one terminal stamp call itself:

```json
{ "binding": "launch_stamp", "operation": "stampPlanV1", "data": "0x", "value": "0" }
```

Never declare a `platform:` action, and never try to fill the stamp.

---

## Never write these

| Forbidden | Why |
|---|---|
| `callcode` | Deprecated unsafe delegation; rejected outright |
| `selfdestruct` / `suicide` | Makes runtime destructible, breaks immutability |

## Disclose these (allowed, but declare them)

| Pattern | Obligation |
|---|---|
| `delegatecall` | Requires evidence disclosure |
| `Ownable` / `onlyOwner` / `Pausable` | Privileged control — disclose |
| `mint*` functions | Supply-affecting — disclose |

Put them in `programmable-launch.config.json` under `disclosures`. Declared is fine;
discovered in review is not.

---

## Config fields that silently fail

- **`profileDigest`** — must be the live value from `GET /v4/chains/4663/capabilities`.
  A stale digest fails with `PLAN_MANIFEST_MISMATCH`.
- **Raw integer strings** — `totalSupply`, `valueWei` and friends are strings, not JSON
  numbers. Numbers above 2^53 lose precision.
- **`chainId`** — the v4 API returns it as the **string** `"4663"`, while the v2 read API
  returns the number `4663`. Don't `===` across the two.
- **v4 is chain 4663 only.** Any other chain returns `CUSTOM_LAUNCH_CHAIN_MISMATCH`.

---

## Lifecycle

```
received → validating → action_required → authorized →
awaiting_wallet_signature → wallet_action_required → submitted →
sequencer_soft_confirmed → ethereum_posted → finalized
                                                  failed (terminal)
```

- **`action_required`** — waiting on *you*. Read `failure.code`. Polling will not advance
  it.
- **`authorized`** — `walletHandoffUrl` is now available. This is the state to wait for
  before signing.
- **`failed`** — the only terminal failure. `failure.retryable` says whether a new
  attempt is worthwhile.

A `failure` object on an `action_required` launch describes what to fix — it does not
mean the launch is dead.

---

## Checklist before submitting

1. `npx programmable-check ./src/` exits 0
2. Every warning is declared under `disclosures`
3. `pragma solidity 0.8.26;` exact
4. PoolManager injected, never hardcoded
5. `getHookPermissions()` matches implemented functions exactly
6. Return-delta bits have their parent callbacks
7. Live `profileDigest` bound
8. No `TODO` left in `programmable-launch.config.json`
