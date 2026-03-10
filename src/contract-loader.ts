import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { pathToFileURL } from 'node:url';
import { contractArtifacts, type ContractVersion } from './config.js';

export const loadCompiledContract = async (version: ContractVersion) => {
  const artifact = contractArtifacts[version];
  const modulePath = pathToFileURL(`${artifact.managedPath}/contract/index.js`);
  const contractModule = await import(modulePath.href);
  const compiledContract = CompiledContract.make(artifact.contractName, contractModule.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(artifact.managedPath),
  );

  return {
    contractModule,
    compiledContract,
    zkConfigPath: artifact.managedPath,
  };
};
