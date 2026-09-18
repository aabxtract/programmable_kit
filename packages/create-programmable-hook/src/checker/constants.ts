/**
 * Facts about the Programmable v4 admission profile.
 *
 * These are not invented. Every value here was read from the live contract manifest at
 * `GET /v4/chains/4663/custom-launch-contract/manifest.json` and the capabilities
 * endpoint, on 2026-09-17. Re-read them with `programmable-check --show-profile`.
 */

/** Exact compiler the platform pins. From capabilities `toolchains[0]`. */
export const REQUIRED_SOLC = "0.8.26+commit.8a97fa7a";
export const REQUIRED_PRAGMA = "0.8.26";

/** Deployed runtime size ceiling, from manifest `limits.runtimeBytes` (EIP-170). */
export const MAX_RUNTIME_BYTES = 24_576;
/** Init code ceiling, from manifest `limits.initCodeBytes`. */
export const MAX_INIT_CODE_BYTES = 49_152;

/** Action ids the platform reserves for itself. From `reservedActionIdPrefixes`. */
export const RESERVED_ACTION_PREFIXES = ["platform:"] as const;

/**
 * The 14 hook address permission bits, with their exact bit positions.
 *
 * Straight from manifest `hookPermissionBits`. The bit position matters: a v4 hook's
 * permissions are encoded in its deployed *address*, so these must agree with both
 * `getHookPermissions()` and the mined address.
 */
export const HOOK_PERMISSION_BITS = {
  beforeInitialize: 13,
  afterInitialize: 12,
  beforeAddLiquidity: 11,
  afterAddLiquidity: 10,
  beforeRemoveLiquidity: 9,
  afterRemoveLiquidity: 8,
  beforeSwap: 7,
  afterSwap: 6,
  beforeDonate: 5,
  afterDonate: 4,
  beforeSwapReturnDelta: 3,
  afterSwapReturnDelta: 2,
  afterAddLiquidityReturnDelta: 1,
  afterRemoveLiquidityReturnDelta: 0,
} as const;

export type PermissionName = keyof typeof HOOK_PERMISSION_BITS;

/**
 * The 10 bits that correspond to an actual callback function.
 *
 * The other four are return-delta *flags*, not functions — enabling
 * `beforeSwapReturnDelta` does not mean you implement a `beforeSwapReturnDelta()`.
 * Conflating the two produces false "missing callback" errors, which is why this split
 * exists.
 */
export const CALLBACK_PERMISSIONS = [
  "beforeInitialize",
  "afterInitialize",
  "beforeAddLiquidity",
  "afterAddLiquidity",
  "beforeRemoveLiquidity",
  "afterRemoveLiquidity",
  "beforeSwap",
  "afterSwap",
  "beforeDonate",
  "afterDonate",
] as const satisfies readonly PermissionName[];

/** The 10 permission names that are real callbacks, excluding the return-delta flags. */
export type CallbackName = (typeof CALLBACK_PERMISSIONS)[number];

/**
 * Return-delta flags and the callback each one depends on.
 *
 * Manifest invariant `hook_permissions`: "All 14 address permission bits and
 * return-delta dependencies agree with the declaration." Enabling a return-delta bit
 * without its parent callback violates that.
 */
export const RETURN_DELTA_DEPENDENCIES: Readonly<Record<string, PermissionName>> = {
  beforeSwapReturnDelta: "beforeSwap",
  afterSwapReturnDelta: "afterSwap",
  afterAddLiquidityReturnDelta: "afterAddLiquidity",
  afterRemoveLiquidityReturnDelta: "afterRemoveLiquidity",
};

/**
 * Callbacks that change state and therefore must reject non-PoolManager callers.
 *
 * Manifest invariant `callback_authority`: "Effectful callbacks reject callers other
 * than the bound PoolManager."
 */
export const EFFECTFUL_CALLBACKS: readonly CallbackName[] = CALLBACK_PERMISSIONS;

/** Expected return arity per callback, from the v4 `IHooks` ABI. */
export const CALLBACK_RETURN_SHAPE: Readonly<Record<CallbackName, string[]>> = {
  beforeInitialize: ["bytes4"],
  afterInitialize: ["bytes4"],
  beforeAddLiquidity: ["bytes4"],
  afterAddLiquidity: ["bytes4", "BalanceDelta"],
  beforeRemoveLiquidity: ["bytes4"],
  afterRemoveLiquidity: ["bytes4", "BalanceDelta"],
  beforeSwap: ["bytes4", "BeforeSwapDelta", "uint24"],
  afterSwap: ["bytes4", "int128"],
  beforeDonate: ["bytes4"],
  afterDonate: ["bytes4"],
};

/** The platform's reserved terminal stamp call, from `explicitStampPlaceholder`. */
export const STAMP_PLACEHOLDER = {
  binding: "launch_stamp",
  operation: "stampPlanV1",
  data: "0x",
  value: "0",
} as const;

/** Live manifest invariants, quoted verbatim. Findings cite these. */
export const INVARIANTS = {
  callback_authority:
    "Effectful callbacks reject callers other than the bound PoolManager.",
  hook_permissions:
    "All 14 address permission bits and return-delta dependencies agree with the declaration.",
  callback_abi: "Enabled callbacks have the exact required selector and return shape.",
  source_binding:
    "Every declared component binds an exact compilation unit, source and constructor/runtime materialization.",
  runtime_binding: "Declared, compiled and observed critical runtime hashes agree.",
  platform_authority:
    "Platform authority is restricted to one terminal call with the released launch_stamp target, stampPlanV1 operation, empty data and zero value.",
} as const;
