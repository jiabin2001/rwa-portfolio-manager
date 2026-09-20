import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { Action, connected, deadlineIn, deployContract, deployLab, signAction, swapParams } from "../scripts/lib/localLab";

type Lab = Awaited<ReturnType<typeof deployLab>>;
const amount = ethers.parseEther("100");

async function swap(lab: Lab, quantity = amount, minimum = quantity) {
  return swapParams(await lab.tokenIn.getAddress(), await lab.tokenOut.getAddress(), quantity, minimum);
}

async function execute(lab: Lab, actionType: number, params = "0x", nonce = 0n) {
  const deadline = await deadlineIn();
  const sigs = await signAction(lab.queue, [lab.owner, lab.secondApprover], actionType, params, nonce, deadline);
  return connected(lab.queue, lab.relayer).executeWithSignatures(actionType, params, nonce, deadline, sigs);
}

describe("Offline contract lab", function () {
  it("moves input and output tokens through a quorum-approved constrained swap", async function () {
    const lab = await loadFixture(deployLab);
    const params = await swap(lab);
    await expect(execute(lab, Action.REBALANCE, params)).to.emit(lab.router, "DexSwap")
      .withArgs(await lab.tokenIn.getAddress(), await lab.tokenOut.getAddress(), amount, amount, amount);
    expect(await lab.tokenIn.balanceOf(await lab.vault.getAddress())).to.equal(lab.startingBalance - amount);
    expect(await lab.tokenOut.balanceOf(await lab.vault.getAddress())).to.equal(amount);
    expect(await lab.tokenIn.balanceOf(await lab.dex.getAddress())).to.equal(amount);
    expect(await lab.tokenOut.balanceOf(await lab.dex.getAddress())).to.equal(lab.startingBalance - amount);
    expect(await lab.tokenIn.balanceOf(await lab.router.getAddress())).to.equal(0);
    expect(await lab.tokenIn.allowance(await lab.router.getAddress(), await lab.dex.getAddress())).to.equal(0);
  });

  it("permits actual fills inside the quote-based slippage limit", async function () {
    const lab = await loadFixture(deployLab);
    await lab.dex.setPair(await lab.tokenIn.getAddress(), await lab.tokenOut.getAddress(), 1, 1, 996, 1000);
    await execute(lab, Action.HEDGE, await swap(lab, amount, amount * 995n / 1000n));
    expect(await lab.tokenOut.balanceOf(await lab.vault.getAddress())).to.equal(amount * 996n / 1000n);
  });

  it("rejects caller-supplied minOut below the configured slippage floor", async function () {
    const lab = await loadFixture(deployLab);
    await expect(execute(lab, Action.REBALANCE, await swap(lab, amount, amount * 994n / 1000n))).to.be.revertedWith("slippage");
    expect(await lab.queue.usedNonces(0)).to.equal(false);
    expect(await lab.tokenIn.balanceOf(await lab.vault.getAddress())).to.equal(lab.startingBalance);
  });

  it("rounds the slippage floor up so a one-unit quote cannot allow zero output", async function () {
    const lab = await loadFixture(deployLab);
    await expect(execute(lab, Action.REBALANCE, await swap(lab, 1n, 0n))).to.be.revertedWith("slippage");
  });

  it("rejects trades above the input-balance turnover cap", async function () {
    const lab = await loadFixture(deployLab);
    await expect(execute(lab, Action.REBALANCE, await swap(lab, ethers.parseEther("501")))).to.be.revertedWith("turnover");
    expect(await lab.queue.usedNonces(0)).to.equal(false);
  });

  it("rolls back failed settlement and permits the same signed action to retry", async function () {
    const lab = await loadFixture(deployLab);
    await lab.dex.setPair(await lab.tokenIn.getAddress(), await lab.tokenOut.getAddress(), 1, 1, 99, 100);
    const params = await swap(lab, amount, amount * 995n / 1000n);
    const deadline = await deadlineIn();
    const sigs = await signAction(lab.queue, [lab.owner, lab.secondApprover], Action.REBALANCE, params, 0n, deadline);
    await expect(lab.queue.executeWithSignatures(Action.REBALANCE, params, 0, deadline, sigs)).to.be.revertedWith("minOut");
    expect(await lab.tokenIn.balanceOf(await lab.vault.getAddress())).to.equal(lab.startingBalance);
    expect(await lab.queue.usedNonces(0)).to.equal(false);
    const hash = await lab.queue.hashAction(Action.REBALANCE, params, 0, deadline);
    expect(await lab.queue.executed(hash)).to.equal(false);
    await lab.dex.setPair(await lab.tokenIn.getAddress(), await lab.tokenOut.getAddress(), 1, 1, 1, 1);
    await lab.queue.executeWithSignatures(Action.REBALANCE, params, 0, deadline, sigs);
    expect(await lab.queue.executed(hash)).to.equal(true);
    expect(await lab.tokenOut.balanceOf(await lab.vault.getAddress())).to.equal(amount);
  });

  it("rejects a venue that reports output without delivering it", async function () {
    const lab = await loadFixture(deployLab);
    const badDex = await deployContract("NonDeliveringDex");
    await lab.router.setDex(await badDex.getAddress());
    await expect(execute(lab, Action.REBALANCE, await swap(lab))).to.be.revertedWith("insufficient output");
    expect(await lab.tokenIn.balanceOf(await lab.vault.getAddress())).to.equal(lab.startingBalance);
    expect(await lab.tokenIn.balanceOf(await badDex.getAddress())).to.equal(0);
    expect(await lab.tokenOut.balanceOf(await lab.vault.getAddress())).to.equal(0);
    expect(await lab.queue.usedNonces(0)).to.equal(false);
  });

  it("does not let a whitelisted caller redeem or withdraw directly", async function () {
    const lab = await loadFixture(deployLab);
    await expect(connected(lab.vault, lab.recipient).redeem(lab.recipient.address, await lab.tokenIn.getAddress(), lab.startingBalance))
      .to.be.revertedWith("only router");
    await expect(connected(lab.vault, lab.outsider).transferToRouter(await lab.tokenIn.getAddress(), amount))
      .to.be.revertedWith("only router");
    expect(await lab.tokenIn.balanceOf(await lab.vault.getAddress())).to.equal(lab.startingBalance);
  });

  it("redeems through the queue only to an allowed recipient", async function () {
    const lab = await loadFixture(deployLab);
    const encode = (to: string) => ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint256"], [to, lab.tokenIn.target, amount],
    );
    await expect(execute(lab, Action.REDEEM, encode(lab.outsider.address))).to.be.revertedWith("not allowed");
    await expect(execute(lab, Action.REDEEM, encode(lab.recipient.address)))
      .to.emit(lab.vault, "Redeemed").withArgs(await lab.tokenIn.getAddress(), lab.recipient.address, amount);
    expect(await lab.tokenIn.balanceOf(lab.recipient.address)).to.equal(amount);
    expect(await lab.tokenIn.balanceOf(await lab.vault.getAddress())).to.equal(lab.startingBalance - amount);
  });

  it("allows approved PAUSE then UNPAUSE, while blocking asset actions in between", async function () {
    const lab = await loadFixture(deployLab);
    await execute(lab, Action.PAUSE);
    expect(await lab.router.paused()).to.equal(true);
    await expect(execute(lab, Action.REBALANCE, await swap(lab), 1n)).to.be.revertedWith("paused");
    expect(await lab.queue.usedNonces(1)).to.equal(false);
    await execute(lab, Action.UNPAUSE, "0x", 2n);
    expect(await lab.router.paused()).to.equal(false);
    await execute(lab, Action.REBALANCE, await swap(lab), 1n);
    expect(await lab.tokenOut.balanceOf(await lab.vault.getAddress())).to.equal(amount);
  });

  it("respects an independent emergency pause on the vault", async function () {
    const lab = await loadFixture(deployLab);
    await lab.vault.setPaused(true);
    await execute(lab, Action.UNPAUSE);
    await expect(execute(lab, Action.REBALANCE, await swap(lab), 1n)).to.be.revertedWith("paused");
    expect(await lab.vault.paused()).to.equal(true);
  });

  it("reverts unsupported and malformed actions without consuming their nonce", async function () {
    const lab = await loadFixture(deployLab);
    await expect(execute(lab, Action.UPDATE_CONSTRAINTS)).to.be.revertedWith("unsupported action");
    await expect(execute(lab, Action.REBALANCE, "0x")).to.be.revertedWith("invalid params");
    await expect(execute(lab, Action.PAUSE, ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [0]))).to.be.revertedWith("invalid params");
    expect(await lab.queue.usedNonces(0)).to.equal(false);
  });

  it("restricts defensive mode to hedge/redemption and control actions", async function () {
    const lab = await loadFixture(deployLab);
    await lab.constraints.setParams(50, 500, true);
    await expect(execute(lab, Action.REBALANCE, await swap(lab))).to.be.revertedWith("defensive mode");
    await execute(lab, Action.HEDGE, await swap(lab));
    expect(await lab.tokenOut.balanceOf(await lab.vault.getAddress())).to.equal(amount);
  });

  it("rejects callers that bypass the signature queue", async function () {
    const lab = await loadFixture(deployLab);
    await expect(connected(lab.router, lab.outsider).execute(Action.PAUSE, "0x")).to.be.revertedWith("only queue");
  });

  it("requires quorum and rejects empty or duplicated approvals", async function () {
    const lab = await loadFixture(deployLab);
    const deadline = await deadlineIn();
    const one = await signAction(lab.queue, [lab.owner], Action.PAUSE, "0x", 0n, deadline);
    await expect(lab.queue.executeWithSignatures(Action.PAUSE, "0x", 0, deadline, [])).to.be.revertedWith("insufficient approvals");
    await expect(lab.queue.executeWithSignatures(Action.PAUSE, "0x", 0, deadline, one)).to.be.revertedWith("insufficient approvals");
    await expect(lab.queue.executeWithSignatures(Action.PAUSE, "0x", 0, deadline, [one[0], one[0]])).to.be.revertedWith("dup/order");
    await expect(lab.queue.setThresholdBps(0)).to.be.revertedWith("threshold");
    await execute(lab, Action.PAUSE);
    expect(await lab.router.paused()).to.equal(true);
  });

  it("rejects a repeated signature/action and nonce reuse with different content", async function () {
    const lab = await loadFixture(deployLab);
    const deadline = await deadlineIn();
    const sigs = await signAction(lab.queue, [lab.owner, lab.secondApprover], Action.PAUSE, "0x", 0n, deadline);
    await lab.queue.executeWithSignatures(Action.PAUSE, "0x", 0, deadline, sigs);
    await expect(lab.queue.executeWithSignatures(Action.PAUSE, "0x", 0, deadline, sigs)).to.be.revertedWith("nonce used");
    await expect(execute(lab, Action.UNPAUSE, "0x", 0n)).to.be.revertedWith("nonce used");
  });

  it("rejects expired and owner-cancelled authorizations", async function () {
    const lab = await loadFixture(deployLab);
    const deadline = await deadlineIn(-1);
    const sigs = await signAction(lab.queue, [lab.owner, lab.secondApprover], Action.PAUSE, "0x", 0n, deadline);
    await expect(lab.queue.executeWithSignatures(Action.PAUSE, "0x", 0, deadline, sigs)).to.be.revertedWith("expired");
    await lab.queue.cancelNonce(0);
    await expect(execute(lab, Action.PAUSE)).to.be.revertedWith("nonce used");
  });

  it("binds signatures to the exact action, parameters and chain", async function () {
    const lab = await loadFixture(deployLab);
    const deadline = await deadlineIn();
    const sigs = await signAction(lab.queue, [lab.owner, lab.secondApprover], Action.PAUSE, "0x", 0n, deadline);
    await expect(lab.queue.executeWithSignatures(Action.UNPAUSE, "0x", 0, deadline, sigs)).to.be.reverted;
    const wrongChain = await signAction(lab.queue, [lab.owner, lab.secondApprover], Action.PAUSE, "0x", 0n, deadline, { chainId: 31338n });
    await expect(lab.queue.executeWithSignatures(Action.PAUSE, "0x", 0, deadline, wrongChain)).to.be.reverted;
    const swapSignatures = await signAction(lab.queue, [lab.owner, lab.secondApprover], Action.REBALANCE, await swap(lab), 0n, deadline);
    await expect(lab.queue.executeWithSignatures(Action.REBALANCE, await swap(lab, amount * 2n), 0, deadline, swapSignatures)).to.be.reverted;
    expect(await lab.queue.usedNonces(0)).to.equal(false);
  });

  it("prevents signature replay against a second queue on the same chain", async function () {
    const lab = await loadFixture(deployLab);
    const deadline = await deadlineIn();
    const sigs = await signAction(lab.queue, [lab.owner, lab.secondApprover], Action.PAUSE, "0x", 0n, deadline);
    const secondQueue = await deployContract("TransactionQueue", [lab.owner.address, await lab.registry.getAddress(), await lab.router.getAddress()]);
    await lab.router.setQueue(await secondQueue.getAddress());
    await expect(secondQueue.executeWithSignatures(Action.PAUSE, "0x", 0, deadline, sigs)).to.be.reverted;
    const correct = await signAction(secondQueue, [lab.owner, lab.secondApprover], Action.PAUSE, "0x", 0n, deadline);
    await secondQueue.executeWithSignatures(Action.PAUSE, "0x", 0, deadline, correct);
    expect(await lab.router.paused()).to.equal(true);
  });

  it("updates quorum weight accounting and rejects deactivated signers", async function () {
    const lab = await loadFixture(deployLab);
    const deadline = await deadlineIn();
    const sigs = await signAction(lab.queue, [lab.owner, lab.secondApprover], Action.PAUSE, "0x", 0n, deadline);
    await lab.registry.setAgent(lab.secondApprover.address, 4, 4000, false);
    expect(await lab.registry.totalActiveWeightBps()).to.equal(6000);
    await expect(lab.queue.executeWithSignatures(Action.PAUSE, "0x", 0, deadline, sigs)).to.be.revertedWith("inactive signer");
    const remaining = await signAction(lab.queue, [lab.owner], Action.PAUSE, "0x", 0n, deadline);
    await lab.queue.executeWithSignatures(Action.PAUSE, "0x", 0, deadline, remaining);
    expect(await lab.router.paused()).to.equal(true);
  });

  it("does not emit a successful sweep when an ERC20 returns false", async function () {
    const lab = await loadFixture(deployLab);
    const token = await deployContract("FalseReturnToken", [lab.owner.address]);
    await token.mint(await lab.vault.getAddress(), amount);
    await expect(lab.vault.sweep(await token.getAddress(), lab.owner.address, amount))
      .to.be.revertedWithCustomError(lab.vault, "SafeERC20FailedOperation").withArgs(await token.getAddress());
    expect(await token.balanceOf(await lab.vault.getAddress())).to.equal(amount);
    expect(await token.balanceOf(lab.owner.address)).to.equal(0);
  });
});
