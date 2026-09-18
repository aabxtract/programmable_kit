// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";

/// @title BuybackHook
/// @notice Accrues a share of swap volume into a buyback treasury.
/// @dev Structured for Programmable's admission invariants:
///      - pragma pinned to 0.8.26 exactly (the platform compiles with
///        0.8.26+commit.8a97fa7a; a floating pragma changes the bound runtime hash)
///      - PoolManager injected via constructor and held immutable, never hardcoded
///      - every effectful callback rejects non-PoolManager callers
///      - getHookPermissions() enables exactly the callbacks implemented below
contract BuybackHook is IHooks {
    /// @notice Thrown when a callback is invoked by anything other than the PoolManager.
    error NotPoolManager();
    error InvalidPoolManager();
    error BpsTooHigh();

    /// @notice The bound PoolManager. Set once at construction.
    IPoolManager public immutable poolManager;

    /// @notice Where accrued buyback value is credited.
    address public immutable treasury;

    /// @notice Share of swap volume accrued, in basis points.
    uint24 public immutable buybackBps;

    /// @dev Upper bound on the configured share. 10_000 bps == 100%.
    uint24 private constant MAX_BPS = 1_000;

    /// @notice Cumulative notional routed through this hook, per pool.
    mapping(bytes32 poolId => uint256 accrued) public accruedNotional;

    event BuybackAccrued(bytes32 indexed poolId, uint256 amount);

    /// @dev Guards every effectful callback. Invariant `callback_authority`.
    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManager _poolManager, address _treasury, uint24 _buybackBps) {
        if (address(_poolManager) == address(0)) revert InvalidPoolManager();
        if (_buybackBps > MAX_BPS) revert BpsTooHigh();

        poolManager = _poolManager;
        treasury = _treasury;
        buybackBps = _buybackBps;
    }

    /// @notice Declares which callbacks this hook implements.
    /// @dev Must agree with the mined hook address bits AND with the functions below.
    ///      Only `afterSwap` is enabled, so only `afterSwap` is implemented.
    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @inheritdoc IHooks
    /// @dev Returns (bytes4, int128) exactly as the v4 interface requires. Returning a
    ///      non-zero int128 would require the afterSwapReturnDelta bit, which is off.
    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        bytes32 poolId = keccak256(abi.encode(key));

        int128 amount0 = delta.amount0();
        uint256 notional = amount0 < 0 ? uint256(uint128(-amount0)) : uint256(uint128(amount0));
        uint256 accrued = (notional * buybackBps) / 10_000;

        if (accrued != 0) {
            accruedNotional[poolId] += accrued;
            emit BuybackAccrued(poolId, accrued);
        }

        return (IHooks.afterSwap.selector, int128(0));
    }

    // ------------------------------------------------------------------
    // Disabled callbacks.
    //
    // IHooks requires the full surface, but every one of these is OFF in
    // getHookPermissions() and reverts if somehow reached. They carry no logic, so
    // they are not "effectful" and need no PoolManager guard.
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

    function beforeSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata)
        external
        pure
        returns (bytes4, BeforeSwapDelta, uint24)
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
