import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { sampleSigningKey, signatureVerifyingKey } from '@midnight-ntwrk/compact-runtime';
import { loadUpgradeEnv, resolveConfig } from './config.js';
import { loadCompiledContract } from './contract-loader.js';
import { manifestPath, writeManifest } from './manifest.js';
import { buildWallet, createProviders, ensureWalletReady, stopWallet } from './providers.js';

const run = async () => {
  const env = loadUpgradeEnv();
  const config = resolveConfig(env);
  const signingKey = env.signingKey ?? sampleSigningKey();
  const verifyingKey = signatureVerifyingKey(signingKey);

  console.log(`[upgrade] network=${env.network}`);
  console.log(`[upgrade] deploying version=${env.version}`);
  console.log(`[upgrade] using maintenance verifying key=${verifyingKey}`);
  if (!env.signingKey) {
    console.log('[upgrade] sampled a fresh maintenance signing key for this deployment');
    console.log('[upgrade] store this signing key securely; it is required for later maintenance actions');
    console.log(`[upgrade] maintenance signing key=${signingKey}`);
  }

  const walletBundle = await buildWallet(config, env.mnemonic);
  try {
    await ensureWalletReady(walletBundle.wallet, config.network);
    const { compiledContract, zkConfigPath } = await loadCompiledContract('v1');
    const providers = await createProviders(
      walletBundle.wallet,
      config,
      {
        shieldedSecretKeys: walletBundle.shieldedSecretKeys,
        dustSecretKey: walletBundle.dustSecretKey,
      },
      walletBundle.unshieldedKeystore,
      zkConfigPath,
    );

    const deployed = await deployContract(providers as never, {
      compiledContract,
      privateStateId: 'upgradableCounterPrivateState',
      initialPrivateState: {},
      signingKey,
      args: [env.initialCounter, env.initialStep],
    } as never);

    const manifest = {
      contractAddress: deployed.deployTxData.public.contractAddress,
      txId: deployed.deployTxData.public.txId ?? null,
      blockHeight: deployed.deployTxData.public.blockHeight ?? null,
      compiledVersion: 'v1' as const,
      initialCounter: env.initialCounter.toString(),
      initialStep: env.initialStep.toString(),
      maintenanceVerifyingKey: verifyingKey,
      network: env.network,
    };

    writeManifest(manifest);

    console.log(`[upgrade] deployed contract=${deployed.deployTxData.public.contractAddress}`);
    if (deployed.deployTxData.public.txId) {
      console.log(
        `[upgrade] deploy txId=${deployed.deployTxData.public.txId} block=${deployed.deployTxData.public.blockHeight ?? 'unknown'}`,
      );
    }
    console.log(`[upgrade] wrote non-secret manifest to ${manifestPath}`);
  } finally {
    await stopWallet(walletBundle);
  }
};

run().catch((error) => {
  console.error('[upgrade] deploy failed', error);
  process.exitCode = 1;
});
