import { ethers, network } from "hardhat";
import { Contract, Signer } from "ethers";

export const Action = { REBALANCE: 0, HEDGE: 1, REDEEM: 2, PAUSE: 3, UNPAUSE: 4, UPDATE_CONSTRAINTS: 5 } as const;
export const actionTypes = {
  Action: [
    { name: "actionType", type: "uint8" },
    { name: "paramsHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export async function assertLocalLabNetwork(): Promise<void> {
  if (network.name !== "hardhat") throw new Error("This lab only runs on the in-process Hardhat network.");
  if ((await ethers.provider.getNetwork()).chainId !== 31337n) throw new Error("Unexpected local chain ID.");
}

export async function deployContract(name: string, args: unknown[] = []): Promise<Contract> {
  const contract = await ethers.deployContract(name, args);
  await contract.waitForDeployment();
  return contract as unknown as Contract;
}

export function connected(contract: Contract, signer: Signer): Contract {
  return contract.connect(signer) as Contract;
}

export async function deployLab() {
  await assertLocalLabNetwork();
  const [owner, secondApprover, relayer, recipient, outsider] = await ethers.getSigners();
  const whitelist = await deployContract("ComplianceWhitelist", [owner.address]);
  const registry = await deployContract("AgentRegistry", [owner.address]);
  const constraints = await deployContract("ConstraintStore", [owner.address]);
  const vault = await deployContract("PortfolioVault", [owner.address, await whitelist.getAddress()]);
  const router = await deployContract("ExecutionRouter", [owner.address, await constraints.getAddress(), await vault.getAddress()]);
  const queue = await deployContract("TransactionQueue", [owner.address, await registry.getAddress(), await router.getAddress()]);
  const dex = await deployContract("MockDex", [owner.address]);
  const tokenIn = await deployContract("MockToken", ["Local Input", "LIN", owner.address]);
  const tokenOut = await deployContract("MockToken", ["Local Output", "LOUT", owner.address]);
  await (await registry.setAgent(owner.address, 6, 6000, true)).wait();
  await (await registry.setAgent(secondApprover.address, 4, 4000, true)).wait();
  await (await vault.setRouter(await router.getAddress())).wait();
  await (await router.setQueue(await queue.getAddress())).wait();
  await (await router.setDex(await dex.getAddress())).wait();
  await (await whitelist.setInvestor(recipient.address, true, 826, true)).wait();
  await (await dex.setPair(await tokenIn.getAddress(), await tokenOut.getAddress(), 1, 1, 1, 1)).wait();
  const startingBalance = ethers.parseEther("10000");
  await (await tokenIn.mint(await vault.getAddress(), startingBalance)).wait();
  await (await tokenOut.mint(await dex.getAddress(), startingBalance)).wait();
  return { owner, secondApprover, relayer, recipient, outsider, whitelist, registry, constraints, vault, router, queue, dex, tokenIn, tokenOut, startingBalance };
}

export function swapParams(tokenIn: string, tokenOut: string, amountIn: bigint, minAmountOut: bigint): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint256", "uint256"], [tokenIn, tokenOut, amountIn, minAmountOut],
  );
}

export async function deadlineIn(seconds = 300): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("Local block unavailable");
  return BigInt(block.timestamp + seconds);
}

export async function signAction(
  queue: Contract, signers: Signer[], actionType: number, params: string, nonce: bigint, deadline: bigint,
  domainOverride: { chainId?: bigint; verifyingContract?: string } = {},
): Promise<string[]> {
  const domain = {
    name: "RWA Local Transaction Queue",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await queue.getAddress(),
    ...domainOverride,
  };
  const value = { actionType, paramsHash: ethers.keccak256(params), nonce, deadline };
  const signatures = await Promise.all(signers.map(async signer => ({
    address: await signer.getAddress(),
    signature: await signer.signTypedData(domain, actionTypes, value),
  })));
  signatures.sort((a, b) => BigInt(a.address) < BigInt(b.address) ? -1 : BigInt(a.address) > BigInt(b.address) ? 1 : 0);
  return signatures.map(item => item.signature);
}
