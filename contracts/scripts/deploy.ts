import assert from "node:assert/strict";
import { ethers } from "hardhat";
import { Action, connected, deadlineIn, deployLab, signAction, swapParams } from "./lib/localLab";

async function main() {
  const lab = await deployLab(); // Refuses all networks except in-process Hardhat.
  const amount = ethers.parseEther("100");
  const vaultAddress = await lab.vault.getAddress();
  const dexAddress = await lab.dex.getAddress();
  const beforeIn = await lab.tokenIn.balanceOf(vaultAddress) as bigint;
  const beforeOut = await lab.tokenOut.balanceOf(vaultAddress) as bigint;
  const params = swapParams(await lab.tokenIn.getAddress(), await lab.tokenOut.getAddress(), amount, amount);
  const nonce = 0n;
  const deadline = await deadlineIn();
  const signatures = await signAction(lab.queue, [lab.owner, lab.secondApprover], Action.REBALANCE, params, nonce, deadline);
  const tx = await connected(lab.queue, lab.relayer).executeWithSignatures(Action.REBALANCE, params, nonce, deadline, signatures);
  const receipt = await tx.wait();
  assert.equal(receipt.status, 1);
  const afterIn = await lab.tokenIn.balanceOf(vaultAddress) as bigint;
  const afterOut = await lab.tokenOut.balanceOf(vaultAddress) as bigint;
  assert.equal(afterIn, beforeIn - amount);
  assert.equal(afterOut, beforeOut + amount);
  assert.equal(await lab.tokenIn.balanceOf(dexAddress), amount);
  assert.equal(await lab.tokenOut.balanceOf(dexAddress), lab.startingBalance - amount);
  assert.equal(await lab.tokenIn.balanceOf(await lab.router.getAddress()), 0n);
  assert.equal(await lab.tokenIn.allowance(await lab.router.getAddress(), dexAddress), 0n);
  assert.equal(await lab.queue.usedNonces(nonce), true);
  console.log(JSON.stringify({
    mode: "local-contract-lab",
    chainId: 31337,
    liveExecution: false,
    transactionHash: tx.hash,
    vaultInputBefore: beforeIn.toString(),
    vaultInputAfter: afterIn.toString(),
    vaultOutputBefore: beforeOut.toString(),
    vaultOutputAfter: afterOut.toString(),
    amountTransferred: amount.toString(),
    assertions: "Real mock-token transfers, vault/DEX balances, zero residual allowance and nonce consumption verified.",
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
