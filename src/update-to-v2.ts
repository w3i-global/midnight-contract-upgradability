import { resolveConfig, loadUpgradeEnv } from './config.js';
import { readManifest, writeManifest } from './manifest.js';
import {
  compareVersionVerifierKeys,
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

const asBigInt = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  throw new Error(`Unexpected numeric value: ${String(value)}`);
};

const run = async () => {
  const env = loadUpgradeEnv();
  const config = resolveConfig(env);
  const contractAddress = resolveContractAddress(env);
  const signingKey = resolveSigningKey(env);
  const verifierComparison = await compareVersionVerifierKeys();

  console.log(`[upgrade] updating contract=${contractAddress} from v1 to v2`);
  console.log(
    `[upgrade] verifier-key equality getCounter=${verifierComparison.getCounterEqual} getStep=${verifierComparison.getStepEqual} increment=${verifierComparison.incrementEqual}`,
  );
  if (verifierComparison.incrementEqual) {
    throw new Error('v1 and v2 increment verifier keys are identical; refusing to run maintenance update');
  }

  const v1Runtime = await createRuntime(config, env.mnemonic, 'v1');
  let v2Runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    const foundV1 = await joinDeployedContract(v1Runtime.providers, v1Runtime.compiledContract, contractAddress, signingKey);
    await verifyOnChainKeysMatch(v1Runtime.providers, CIRCUIT_IDS, contractAddress);

    const before = await readLedgerState(v1Runtime.providers, v1Runtime.contractModule, contractAddress);
    console.log(`[upgrade] before update counter=${before.ledger?.counter ?? 'n/a'} step=${before.ledger?.step ?? 'n/a'}`);

    const beforeIncrement = await foundV1.callTx.increment();
    console.log(`[upgrade] baseline increment txId=${getFinalizedTxId(beforeIncrement) ?? 'unknown'}`);
    const afterBaseline = await readLedgerState(v1Runtime.providers, v1Runtime.contractModule, contractAddress);
    const baselineDelta = asBigInt(afterBaseline.ledger?.counter ?? 0n) - asBigInt(before.ledger?.counter ?? 0n);
    console.log(`[upgrade] baseline increment delta=${baselineDelta}`);

    const removeResult = await foundV1.circuitMaintenanceTx.increment.removeVerifierKey();
    console.log(`[upgrade] removed increment verifier key txId=${getFinalizedTxId(removeResult) ?? 'unknown'}`);

    const insertResult = await foundV1.circuitMaintenanceTx.increment.insertVerifierKey(verifierComparison.incrementV2);
    console.log(`[upgrade] inserted v2 increment verifier key txId=${getFinalizedTxId(insertResult) ?? 'unknown'}`);

    v2Runtime = await createRuntime(config, env.mnemonic, 'v2');
    const foundV2 = await joinDeployedContract(v2Runtime.providers, v2Runtime.compiledContract, contractAddress, signingKey);
    await verifyOnChainKeysMatch(v2Runtime.providers, CIRCUIT_IDS, contractAddress);

    const beforePostUpdate = await readLedgerState(v2Runtime.providers, v2Runtime.contractModule, contractAddress);
    const afterUpdateIncrement = await foundV2.callTx.increment();
    console.log(`[upgrade] post-update increment txId=${getFinalizedTxId(afterUpdateIncrement) ?? 'unknown'}`);
    const afterPostUpdate = await readLedgerState(v2Runtime.providers, v2Runtime.contractModule, contractAddress);
    const postUpdateDelta = asBigInt(afterPostUpdate.ledger?.counter ?? 0n) - asBigInt(beforePostUpdate.ledger?.counter ?? 0n);
    console.log(`[upgrade] post-update increment delta=${postUpdateDelta}`);

    const manifest = readManifest();
    if (manifest && manifest.contractAddress === contractAddress) {
      writeManifest({
        ...manifest,
        compiledVersion: 'v2',
      });
    }

    console.log(
      JSON.stringify(
        {
          contractAddress,
          baselineDelta: baselineDelta.toString(),
          postUpdateDelta: postUpdateDelta.toString(),
          maintenanceTxs: {
            removeIncrement: getFinalizedTxId(removeResult),
            insertIncrement: getFinalizedTxId(insertResult),
          },
          manifestUpdatedToVersion: 'v2',
        },
        null,
        2,
      ),
    );
  } finally {
    await stopRuntime(v2Runtime?.walletBundle);
    await stopRuntime(v1Runtime.walletBundle);
  }
};

run().catch((error) => {
  console.error('[upgrade] update-to-v2 failed', error);
  process.exitCode = 1;
});
