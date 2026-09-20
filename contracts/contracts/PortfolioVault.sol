// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./CircuitBreaker.sol";
import "./ComplianceWhitelist.sol";

/**
 * Local execution vault, not a share-issuing investor deposit product.
 * Only the router can release funds or redeem to allowed recipients.
 * The owner is a trusted lab administrator with emergency sweep authority.
 */
contract PortfolioVault is CircuitBreaker, ReentrancyGuard {
    using SafeERC20 for IERC20;

    ComplianceWhitelist public immutable whitelist;
    address public router;

    event RouterSet(address indexed router);
    event Swept(address indexed token, address indexed to, uint256 amount);
    event Redeemed(address indexed token, address indexed to, uint256 amount);

    constructor(address owner_, address whitelist_) CircuitBreaker(owner_) {
        require(whitelist_.code.length > 0, "invalid whitelist");
        whitelist = ComplianceWhitelist(whitelist_);
    }

    modifier onlyRouter() {
        require(msg.sender == router, "only router");
        _;
    }

    function setRouter(address router_) external onlyOwner {
        require(router_.code.length > 0, "invalid router");
        router = router_;
        emit RouterSet(router_);
    }

    function transferToRouter(address token, uint256 amount) external onlyRouter whenNotPaused nonReentrant {
        require(amount > 0, "amount=0");
        IERC20(token).safeTransfer(router, amount);
    }

    // Emergency custody authority is separate from investor redemption.
    function sweep(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "to=0");
        IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }

    function redeem(address to, address token, uint256 amount) external onlyRouter whenNotPaused nonReentrant {
        require(amount > 0, "amount=0");
        require(whitelist.isAllowed(to), "not allowed");
        IERC20(token).safeTransfer(to, amount);
        emit Redeemed(token, to, amount);
    }
}
