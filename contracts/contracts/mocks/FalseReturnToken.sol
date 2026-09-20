// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MockToken.sol";

// Regression fixture for ERC20 contracts that signal failure without reverting.
contract FalseReturnToken is MockToken {
    constructor(address owner_) MockToken("False Return", "FALSE", owner_) {}

    function transfer(address, uint256) public pure override returns (bool) { return false; }
    function transferFrom(address, address, uint256) public pure override returns (bool) { return false; }
    function approve(address, uint256) public pure override returns (bool) { return false; }
}
