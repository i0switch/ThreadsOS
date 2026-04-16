import {
  ContractCompilationError,
  compileContractStore,
} from "../services/contracts/index.js";

try {
  const compiled = compileContractStore();
  console.log(
    JSON.stringify(
      {
        ok: true,
        compiledAt: compiled.compiledAt,
        rootDir: compiled.rootDir,
        agents: compiled.agents.map((contract) => contract.id),
        playbooks: compiled.playbooks.map((contract) => contract.id),
        policies: compiled.policies.map((contract) => contract.id),
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (error instanceof ContractCompilationError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
