import { sampleSigningKey, signatureVerifyingKey } from '@midnight-ntwrk/compact-runtime';
import { loadUpgradeEnv, resolveConfig } from './config.js';
import { readManifest, writeManifest } from './manifest.js';
import {
  createRuntime,
  getFinalizedTxId,
  joinDeployedContract,
  readLedgerState,
  resolveContractAddress,
  resolveSigningKey,
  stopRuntime,
  verifyOnChainKeysMatch,
} from './runtime.js';

const CIRCUIT_IDS = ['getCounter', 'getStep', 'increment'];

const run = async () => {
  const env = loadUpgradeEnv();
  const config = resolveConfig(env);
  const contractAddress = resolveContractAddress(env);
  const currentSigningKey = resolveSigningKey(env);
  const newSigningKey = env.newSigningKey ?? sampleSigningKey();

  if (newSigningKey === currentSigningKey) {
    throw new Error('MN_UPGRADE_NEW_SIGNING_KEY must differ from MN_UPGRADE_SIGNING_KEY');
  }

  console.log(`[upgrade] rotating maintenance authority for contract=${contractAddress}`);
  console.log(`[upgrade] current verifying key=${signatureVerifyingKey(currentSigningKey)}`);
  console.log(`[upgrade] new verifying key=${signatureVerifyingKey(newSigningKey)}`);
  if (!env.newSigningKey) {
    console.log('[upgrade] sampled a fresh replacement authority signing key');
    console.log(`[upgrade] new maintenance signing key=${newSigningKey}`);
  }

  const currentRuntime = await createRuntime(config, env.mnemonic, env.version);
  let newRuntime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    const foundCurrent = await joinDeployedContract(
      currentRuntime.providers,
      currentRuntime.compiledContract,
      contractAddress,
      currentSigningKey,
    );
    await verifyOnChainKeysMatch(currentRuntime.providers, CIRCUIT_IDS, contractAddress);
    const before = await readLedgerState(currentRuntime.providers, currentRuntime.contractModule, contractAddress);
    console.log(`[upgrade] ledger before rotation counter=${before.ledger?.counter ?? 'n/a'} step=${before.ledger?.step ?? 'n/a'}`);

    const rotateResult = await foundCurrent.contractMaintenanceTx.replaceAuthority(newSigningKey);
    console.log(`[upgrade] replaceAuthority txId=${getFinalizedTxId(rotateResult) ?? 'unknown'}`);

    newRuntime = await createRuntime(config, env.mnemonic, env.version);
    const foundNew = await joinDeployedContract(newRuntime.providers, newRuntime.compiledContract, contractAddress, newSigningKey);
    await verifyOnChainKeysMatch(newRuntime.providers, CIRCUIT_IDS, contractAddress);
    const after = await readLedgerState(newRuntime.providers, newRuntime.contractModule, contractAddress);

    const manifest = readManifest();
    if (manifest && manifest.contractAddress === contractAddress) {
      writeManifest({
        ...manifest,
        maintenanceVerifyingKey: signatureVerifyingKey(newSigningKey),
      });
    }

    console.log(`[upgrade] rejoined with new authority at ${foundNew.deployTxData.public.contractAddress}`);
    console.log(`[upgrade] ledger after rotation counter=${after.ledger?.counter ?? 'n/a'} step=${after.ledger?.step ?? 'n/a'}`);
    console.log(
      JSON.stringify(
        {
          contractAddress,
          newMaintenanceVerifyingKey: signatureVerifyingKey(newSigningKey),
          replaceAuthorityTxId: getFinalizedTxId(rotateResult),
        },
        null,
        2,
      ),
    );
  } finally {
    await stopRuntime(newRuntime?.walletBundle);
    await stopRuntime(currentRuntime.walletBundle);
  }
};

run().catch((error) => {
  console.error('[upgrade] rotate-authority failed', error);
  process.exitCode = 1;
});
