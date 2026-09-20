// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * Agent Registry
 * - Maps agent roles to addresses + weights
 * - Used for weighted approval in TransactionQueue / Orchestrator
 */
contract AgentRegistry is Ownable {
    enum Role {
        DATA_PROVENANCE,
        VALUATION_ORACLE,
        LIQUIDITY,
        CREDIT,
        COMPLIANCE,
        STRATEGY,
        EXECUTION,
        ORCHESTRATOR,
        RISK_SENTINEL,
        ANALYST
    }

    struct Agent {
        Role role;
        uint96 weightBps;   // 0..10000
        bool active;
    }

    mapping(address => Agent) public agents;
    uint256 public totalActiveWeightBps;

    event AgentSet(address indexed agent, Role role, uint96 weightBps, bool active);

    constructor(address owner_) Ownable(owner_) {}

    function setAgent(address agent, Role role, uint96 weightBps, bool active) external onlyOwner {
        require(agent != address(0), "agent=0");
        require(weightBps <= 10_000, "weightBps");
        require(!active || weightBps > 0, "active weight=0");
        Agent memory previous = agents[agent];
        uint256 newTotal = totalActiveWeightBps
            - (previous.active ? previous.weightBps : 0)
            + (active ? weightBps : 0);
        require(newTotal <= 10_000, "total weightBps");
        totalActiveWeightBps = newTotal;
        agents[agent] = Agent({ role: role, weightBps: weightBps, active: active });
        emit AgentSet(agent, role, weightBps, active);
    }

    function isActive(address agent) external view returns (bool) {
        return agents[agent].active;
    }

    function weight(address agent) external view returns (uint96) {
        return agents[agent].weightBps;
    }

    function roleOf(address agent) external view returns (Role) {
        return agents[agent].role;
    }
}
