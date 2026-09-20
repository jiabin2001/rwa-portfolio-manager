// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./CircuitBreaker.sol";
import "./ConstraintStore.sol";
import "./PortfolioVault.sol";

/**
 * Offline contract lab. Only the queue dispatches signed, bounded actions.
 * Slippage uses the configured local DEX quote, NOT an independent market oracle.
 * Turnover caps the fraction of the vault's input-token balance per action.
 */
contract ExecutionRouter is CircuitBreaker, ReentrancyGuard {
    using SafeERC20 for IERC20;

    ConstraintStore public immutable constraints;
    PortfolioVault public immutable vault;
    address public queue;
    address public dex;

    enum ActionType { REBALANCE, HEDGE, REDEEM, PAUSE, UNPAUSE, UPDATE_CONSTRAINTS }
    struct SwapParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
    }

    event QueueSet(address indexed queue);
    event DexSet(address indexed dex);
    event Executed(ActionType indexed actionType, bytes params);
    event DexSwap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 minAmountOut, uint256 amountOut);

    constructor(address owner_, address constraints_, address vault_) CircuitBreaker(owner_) {
        require(constraints_.code.length > 0 && vault_.code.length > 0, "invalid dependency");
        constraints = ConstraintStore(constraints_);
        vault = PortfolioVault(vault_);
    }

    modifier onlyQueue() {
        require(msg.sender == queue, "only queue");
        _;
    }

    function setQueue(address queue_) external onlyOwner {
        require(queue_.code.length > 0, "invalid queue");
        queue = queue_;
        emit QueueSet(queue_);
    }

    function setDex(address dex_) external onlyOwner {
        require(dex_.code.length > 0, "invalid dex");
        dex = dex_;
        emit DexSet(dex_);
    }

    function emergencyPause() external onlyOwner { _setPaused(true); }
    function emergencyUnpause() external onlyOwner { _setPaused(false); }

    function execute(ActionType actionType, bytes calldata params) external onlyQueue nonReentrant {
        // Authenticated unpause must remain reachable while the router is paused.
        if (actionType == ActionType.PAUSE || actionType == ActionType.UNPAUSE) {
            require(params.length == 0, "invalid params");
            _setPaused(actionType == ActionType.PAUSE);
        } else {
            require(!paused, "paused");
            if (actionType == ActionType.REBALANCE || actionType == ActionType.HEDGE) {
                require(params.length == 32 * 4, "invalid params");
                require(!constraints.defensiveMode() || actionType == ActionType.HEDGE, "defensive mode");
                _swap(abi.decode(params, (SwapParams)));
            } else if (actionType == ActionType.REDEEM) {
                require(params.length == 32 * 3, "invalid params");
                (address to, address token, uint256 amount) = abi.decode(params, (address, address, uint256));
                vault.redeem(to, token, amount);
            } else {
                revert("unsupported action");
            }
        }
        emit Executed(actionType, params);
    }

    function _swap(SwapParams memory p) private {
        require(dex != address(0), "dex not set");
        require(p.tokenIn != p.tokenOut, "same token");
        require(p.tokenIn.code.length > 0 && p.tokenOut.code.length > 0, "invalid token");
        require(p.amountIn > 0, "amount=0");
        uint256 inputBalance = IERC20(p.tokenIn).balanceOf(address(vault));
        require(p.amountIn <= Math.mulDiv(inputBalance, constraints.maxTurnoverBps(), 10_000), "turnover");
        uint256 quote = ILocalDex(dex).quote(p.tokenIn, p.tokenOut, p.amountIn);
        require(quote > 0, "zero quote");
        uint256 minAllowed = Math.mulDiv(quote, 10_000 - constraints.maxSlippageBps(), 10_000, Math.Rounding.Ceil);
        require(p.minAmountOut >= minAllowed, "slippage");

        uint256 outputBefore = IERC20(p.tokenOut).balanceOf(address(vault));
        uint256 routerInputBefore = IERC20(p.tokenIn).balanceOf(address(this));
        vault.transferToRouter(p.tokenIn, p.amountIn);
        require(IERC20(p.tokenIn).balanceOf(address(this)) == routerInputBefore + p.amountIn, "unsupported input token");
        IERC20(p.tokenIn).forceApprove(dex, p.amountIn);
        ILocalDex(dex).swap(p.tokenIn, p.tokenOut, p.amountIn, p.minAmountOut, address(vault));
        IERC20(p.tokenIn).forceApprove(dex, 0);
        require(IERC20(p.tokenIn).balanceOf(address(this)) == routerInputBefore, "unspent input");
        uint256 received = IERC20(p.tokenOut).balanceOf(address(vault)) - outputBefore;
        require(received >= p.minAmountOut, "insufficient output");
        emit DexSwap(p.tokenIn, p.tokenOut, p.amountIn, p.minAmountOut, received);
    }
}

interface ILocalDex {
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256);
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient)
        external returns (uint256);
}
