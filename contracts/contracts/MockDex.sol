// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * Funded fixed-rate local testing venue; not an AMM, oracle or production DEX.
 * Separate quote/execution ratios simulate slippage while moving real mock ERC20s.
 * Ratios are expressed in raw token units; the trusted owner supplies liquidity.
 */
contract MockDex is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    struct Pair {
        uint256 quoteNumerator;
        uint256 quoteDenominator;
        uint256 executionNumerator;
        uint256 executionDenominator;
    }
    mapping(bytes32 => Pair) public pairs;

    constructor(address owner_) Ownable(owner_) {}

    function setPair(address tokenIn, address tokenOut, uint256 quoteNumerator, uint256 quoteDenominator,
        uint256 executionNumerator, uint256 executionDenominator) external onlyOwner
    {
        require(tokenIn != tokenOut && tokenIn.code.length > 0 && tokenOut.code.length > 0, "invalid pair");
        require(quoteNumerator > 0 && quoteDenominator > 0 && executionNumerator > 0 && executionDenominator > 0, "invalid rate");
        pairs[keccak256(abi.encode(tokenIn, tokenOut))] = Pair(
            quoteNumerator, quoteDenominator, executionNumerator, executionDenominator
        );
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256) {
        Pair memory pair = pairs[keccak256(abi.encode(tokenIn, tokenOut))];
        require(pair.quoteDenominator > 0, "unknown pair");
        return Math.mulDiv(amountIn, pair.quoteNumerator, pair.quoteDenominator);
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient)
        external nonReentrant returns (uint256 amountOut)
    {
        require(recipient != address(0) && amountIn > 0, "invalid swap");
        Pair memory pair = pairs[keccak256(abi.encode(tokenIn, tokenOut))];
        require(pair.executionDenominator > 0, "unknown pair");
        amountOut = Math.mulDiv(amountIn, pair.executionNumerator, pair.executionDenominator);
        require(amountOut >= minAmountOut, "minOut");
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
    }
}
