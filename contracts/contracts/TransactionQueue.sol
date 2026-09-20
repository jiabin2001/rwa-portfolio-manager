// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./AgentRegistry.sol";
import "./ExecutionRouter.sol";

/**
 * Local lab: EIP-712 approvals bind chain, queue, action, params, nonce and expiry.
 * Relayers submit sorted, unique signatures from currently active agents.
 * Quorum uses current active registry weight; registry/threshold changes remain
 * trusted owner operations, not decentralized governance.
 */
contract TransactionQueue is Ownable, EIP712, ReentrancyGuard {
    using ECDSA for bytes32;

    bytes32 public constant ACTION_TYPEHASH = keccak256(
        "Action(uint8 actionType,bytes32 paramsHash,uint256 nonce,uint256 deadline)"
    );
    AgentRegistry public immutable registry;
    ExecutionRouter public immutable router;
    uint96 public thresholdBps = 6700;
    mapping(bytes32 => bool) public executed;
    mapping(uint256 => bool) public usedNonces;

    event ThresholdSet(uint96 thresholdBps);
    event NonceCancelled(uint256 indexed nonce);
    event ActionExecuted(bytes32 indexed actionHash, ExecutionRouter.ActionType actionType);

    constructor(address owner_, address registry_, address router_)
        Ownable(owner_) EIP712("RWA Local Transaction Queue", "1")
    {
        require(registry_.code.length > 0 && router_.code.length > 0, "invalid dependency");
        registry = AgentRegistry(registry_);
        router = ExecutionRouter(router_);
    }

    function setThresholdBps(uint96 thresholdBps_) external onlyOwner {
        require(thresholdBps_ > 0 && thresholdBps_ <= 10_000, "threshold");
        thresholdBps = thresholdBps_;
        emit ThresholdSet(thresholdBps_);
    }

    function cancelNonce(uint256 nonce) external onlyOwner {
        usedNonces[nonce] = true;
        emit NonceCancelled(nonce);
    }

    function hashAction(ExecutionRouter.ActionType actionType, bytes calldata params, uint256 nonce, uint256 deadline)
        public view returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(
            ACTION_TYPEHASH, uint8(actionType), keccak256(params), nonce, deadline
        )));
    }

    function executeWithSignatures(
        ExecutionRouter.ActionType actionType,
        bytes calldata params,
        uint256 nonce,
        uint256 deadline,
        bytes[] calldata sigs
    ) external nonReentrant {
        require(block.timestamp <= deadline, "expired");
        require(!usedNonces[nonce], "nonce used");
        bytes32 actionHash = hashAction(actionType, params, nonce, deadline);
        uint256 totalActiveWeight = registry.totalActiveWeightBps();
        require(totalActiveWeight > 0, "no active agents");
        uint256 approvalWeight;
        address last;
        for (uint256 i = 0; i < sigs.length; i++) {
            address signer = actionHash.recover(sigs[i]);
            require(signer > last, "dup/order");
            last = signer;
            (, uint96 weightBps, bool active) = registry.agents(signer);
            require(active, "inactive signer");
            approvalWeight += weightBps;
        }
        require(approvalWeight * 10_000 >= totalActiveWeight * thresholdBps, "insufficient approvals");

        // Effects precede the external call; any router failure rolls these back.
        usedNonces[nonce] = true;
        executed[actionHash] = true;
        router.execute(actionType, params);
        emit ActionExecuted(actionHash, actionType);
    }
}
