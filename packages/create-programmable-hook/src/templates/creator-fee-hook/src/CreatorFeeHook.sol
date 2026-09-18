// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";

/// @title CreatorFeeHook
/// @notice Applies a creator-set dynamic LP fee on every swap.
/// @dev Structured for Programmable's admission invariants:
///      - pragma pinned to 0.8.26 exactly
///      - PoolManager injected via constructor, held immutable
///      - `beforeSwap` rejects non-PoolManager callers
///      - getHookPermissions() enables exactly the callbacks implemented below
///
///      NOTE: this hook overrides the LP fee, which is a fee-behaviour claim. The
///      capabilities endpoint currently reports `feeBehaviorClaim: false` — confirm it
///      is enabled for your chain before submitting, or admission will reject the claim.
contract CreatorFeeHook is IHooks {
    error NotPoolManager();
    error InvalidPoolManager();
    error FeeTooHigh();

    /// @notice The bound PoolManager. Set once at construction.
    IPoolManager public immutable poolManager;

    /// @notice Creator-set swap fee, in hundredths of a bip (v4 LP fee units).
    uint24 public immutable creatorFee;

    /// @dev v4 caps the LP fee at 100% expressed in pips.
    uint24 private constant MAX_FEE = 1_000_000;

    event FeeApplied(bytes32 indexed poolId, uint24 fee);

    /// @dev Guards every effectful callback. Invariant `callback_authority`.
    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManager _poolManager, uint24 _creatorFee) {
        if (address(_poolManager) == address(0)) revert InvalidPoolManager();
        if (_creatorFee > MAX_FEE) revert FeeTooHigh();

        poolManager = _poolManager;
        creatorFee = _creatorFee;
    }

    /// @notice Declares which callbacks this hook implements.
    /// @dev `beforeSwapReturnDelta` stays false: this hook overrides the fee, it does
    ///      not take a delta. Enabling it without returning a delta is a mismatch.
    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @inheritdoc IHooks
    /// @dev Returns (bytes4, BeforeSwapDelta, uint24) exactly as v4 requires. The delta
    ///      is zero because beforeSwapReturnDelta is off; the uint24 carries the fee
    ///      override, flagged with the dynamic-fee bit.
    function beforeSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        emit FeeApplied(keccak256(abi.encode(key)), creatorFee);

        return (
            IHooks.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            creatorFee | LPFeeLibrary.OVERRIDE_FEE_FLAG
        );
    }

    // ------------------------------------------------------------------
    // Disabled callbacks — all OFF in getHookPermissions(), all revert stubs.
    // ------------------------------------------------------------------

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    error HookNotImplemented();
}
