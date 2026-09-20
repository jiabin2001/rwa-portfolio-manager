// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Adversarial test fixture: claims a fill but delivers no output token.
contract NonDeliveringDex {
    using SafeERC20 for IERC20;

    function quote(address, address, uint256 amountIn) external pure returns (uint256) { return amountIn; }

    function swap(address tokenIn, address, uint256 amountIn, uint256, address) external returns (uint256) {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        return amountIn;
    }
}
