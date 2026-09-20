import { HardhatUserConfig, subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";

// The compiler is installed from the lockfile; compilation never downloads solc.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }: { solcVersion: string }) => {
  if (solcVersion !== "0.8.26") throw new Error(`Unsupported local compiler: ${solcVersion}`);
  const compiler = require("solc") as { version(): string };
  return {
    compilerPath: require.resolve("solc/soljson.js"),
    isSolcJs: true,
    version: solcVersion,
    longVersion: compiler.version(),
  };
});

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  networks: { hardhat: { chainId: 31337, initialDate: "2026-01-01T00:00:00.000Z" } },
  solidity: {
    version: "0.8.26",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
};

export default config;
