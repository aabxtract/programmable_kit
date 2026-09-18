// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// This comment mentions selfdestruct and callcode on purpose — the checker must NOT
// flag these, because comments are stripped before scanning.
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";

contract BadHook is Ownable {
    address public poolManager = 0x000000000004444c5dc75cB358380D2e3dE08A90;

    string private constant ACTION = "platform:stamp";

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
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // HC-003: no PoolManager guard. HC-006: should return 3 values, returns 1.
    function beforeSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata)
        external
        returns (bytes4)
    {
        totalSwaps += 1;
        return bytes4(0);
    }

    // HC-005 inverse: implemented but its permission bit is false.
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        returns (bytes4)
    {
        if (msg.sender != poolManager) revert("no");
        donations += 1;
        return bytes4(0);
    }

    uint256 public totalSwaps;
    uint256 public donations;

    function emergencyExit(address payable to) external onlyOwner {
        selfdestruct(to);
    }

    function proxyCall(address target, bytes calldata data) external onlyOwner {
        (bool ok,) = target.delegatecall(data);
        require(ok, "failed");
    }

    function mintExtra(address to, uint256 amount) external onlyOwner {
        balances[to] += amount;
    }

    mapping(address => uint256) public balances;

    function legacy(address target) external {
        assembly {
            let r := callcode(gas(), target, 0, 0, 0, 0, 0)
        }
    }
}
