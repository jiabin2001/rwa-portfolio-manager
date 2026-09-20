// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * Circuit breaker: emergency pause/unpause controlled by owner (multisig recommended).
 */
contract CircuitBreaker is Ownable {
    bool public paused;

    event Paused(bool paused);

    constructor(address owner_) Ownable(owner_) {}

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    function setPaused(bool _paused) external onlyOwner {
        _setPaused(_paused);
    }

    function _setPaused(bool _paused) internal {
        paused = _paused;
        emit Paused(_paused);
    }
}
