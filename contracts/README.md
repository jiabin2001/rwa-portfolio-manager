# Offline contract lab

This workspace demonstrates a complete signed action on an in-process Hardhat chain: two agents approve a bounded swap, a relayer submits the signatures, the queue checks quorum, and the router settles actual mock ERC20 transfers between a vault and a funded local venue. The demo asserts the resulting vault and venue balances.

The application remains paper-only. This lab has no live RPC configuration, no external deployment path, and no real assets. The deployment helper refuses networks other than the in-process Hardhat chain with chain ID 31337.

## Run

From the repository root, with the supported project Node version:

~~~bash
npm ci
npm run compile -w contracts
npm run typecheck -w contracts
npm run test -w contracts
npm run demo -w contracts
~~~

The first command installs the locked dependencies. Compilation and the remaining commands then run offline: Hardhat uses the pinned local solc 0.8.26 package instead of downloading a compiler. OpenZeppelin Contracts is pinned to 5.0.2. Only the ethers and Chai matcher plugins are enabled, without the toolbox, verification, ignition or coverage plugins. Hardhat's local initial date is fixed to 2026-01-01, and the fixtures use its deterministic local accounts.

Each demo invocation creates a fresh ephemeral chain. It mints 10,000 mock input tokens into the vault and 10,000 mock output tokens into the venue, executes a 100-token swap, and prints a real local transaction hash plus before/after balances. Its assertions also check the venue balances, consumed nonce, zero stranded input and zero residual DEX allowance. Tokens have 18 decimals and represent no real-world asset or claim.

## Contract responsibilities

| Contract | Responsibility |
| --- | --- |
| AgentRegistry | Owner-managed active signers and weights; tracks total active weight. |
| TransactionQueue | Domain-bound EIP-712 approvals, quorum, expiration, unique nonces and cancellation. |
| ExecutionRouter | Queue-only action dispatch, pause controls, parameter validation and swap bounds. |
| PortfolioVault | Router-only asset releases/redemptions; recipient whitelist and SafeERC20 transfers. |
| ConstraintStore | Owner-managed maximum slippage, input-balance turnover and defensive mode. |
| MockDex | Funded fixed-rate venue with separate quote/execution ratios for slippage tests. |
| ComplianceWhitelist | Owner-managed allowed recipients; not an external KYC integration. |

The owner is a trusted lab administrator. It can replace the router/queue/venue, modify constraints and registry weights, pause contracts and sweep vault tokens. This is not decentralized governance or an investor share/deposit accounting system.

## Action and signature interface

The enum values and exact ABI-encoded parameters are:

| Value | Action | Parameters |
| --- | --- | --- |
| 0 | REBALANCE | `(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut)` |
| 1 | HEDGE | Same as REBALANCE. |
| 2 | REDEEM | `(address recipient, address token, uint256 amount)` |
| 3 | PAUSE | Empty bytes `0x`. |
| 4 | UNPAUSE | Empty bytes `0x`. |
| 5 | UPDATE_CONSTRAINTS | Deliberately unsupported; always reverts. The owner changes ConstraintStore directly. |

Malformed or unsupported actions revert rather than generating success events. A router pause blocks asset actions but permits a quorum-approved UNPAUSE. The vault's owner-controlled pause is independent: unpausing the router never clears an emergency pause on the vault.

`executeWithSignatures(actionType, params, nonce, deadline, signatures)` expects EIP-712 signatures over:

~~~text
domain:
  name: RWA Local Transaction Queue
  version: "1"
  chainId: current chain ID
  verifyingContract: queue contract address

Action(uint8 actionType,bytes32 paramsHash,uint256 nonce,uint256 deadline)
paramsHash = keccak256(params)
~~~

`deadline` is a Unix timestamp in seconds. Nonces are unique across all actions in a queue; they need not be sequential. A successful execution consumes its nonce, and the owner can cancel an unused nonce. Reverted execution consumes neither the nonce nor the action hash. Signature arrays must be sorted by recovered signer address in ascending numeric order, without duplicates.

The default quorum is 67% of the **current active weight**, not 6,700 absolute weight units. The default fixture has two signers weighted 6,000 and 4,000, so both are required. Changes to registry membership/weights affect outstanding approvals; expiry and owner cancellation provide explicit controls. The lab does not implement a separate on-chain compliance-agent veto.

## Swap constraints and settlement

The router enforces all of the following before reporting execution:

- Input amount is positive and within `maxTurnoverBps` of the vault's current input-token balance (5% by default).
- The signed minimum output is at least the local venue quote minus `maxSlippageBps` (0.5% by default), rounded up to avoid zero-output allowances on tiny swaps.
- Only the exact input amount is approved to the venue, and the approval is cleared afterward.
- Input is actually consumed, and the vault's measured output balance increase meets the signed minimum. A return value claiming a fill cannot substitute for a balance change.

A failed constraint or settlement check reverts the entire transaction, including transfers and nonce consumption. Defensive mode blocks REBALANCE but permits HEDGE, REDEEM and pause controls; the HEDGE name itself is not proof that an action reduces risk.

These are local testing constraints. The quote comes from an owner-configured mock, not an independent price oracle. Turnover is per action and per input-token balance, not portfolio NAV or a cumulative daily trading budget. Standard, non-rebasing ERC20 behavior is assumed; fee-charging input tokens are rejected. This lab does not establish a safe policy for arbitrary tokens or venues.

## Regression coverage

The deterministic tests cover actual balance-changing settlement, valid and excessive slippage, rounding, turnover, failed-settlement rollback/retry, a venue that lies about output, unauthorized vault withdrawal, whitelist-gated redemption, pause/unpause, unsupported and malformed actions, defensive mode, bypass attempts, quorum, duplicate signatures, replay, expiry, cancellation, action/parameter/chain/queue binding, deactivated signers and false-returning ERC20 transfers.

The remaining `IFdcVerification` interface is an unused historical placeholder. No local action relies on it or claims a verified Flare attestation. No live asset execution or production-readiness claim is made.
