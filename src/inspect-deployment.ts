import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { loadUpgradeEnv, resolveConfig } from './config.js';
import { loadCompiledContract } from './contract-loader.js';
import {
  assertContractAddress,
  buildWallet,
  createProviders,
  ensureWalletReady,
  stopWallet,
} from './providers.js';

const run = async () => {
  const env = loadUpgradeEnv();
  if (!env.contractAddress) {
    throw new Error('MN_UPGRADE_CONTRACT_ADDRESS is required for inspect mode');
  }

  const config = resolveConfig(env);
  const walletBundle = await buildWallet(config, env.mnemonic);
  try {
    await ensureWalletReady(walletBundle.wallet, config.network);
    const { compiledContract, contractModule, zkConfigPath } = await loadCompiledContract(env.version);
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

    const found = await findDeployedContract(providers as never, {
      contractAddress: assertContractAddress(env.contractAddress),
      compiledContract,
      privateStateId: 'upgradableCounterPrivateState',
      initialPrivateState: {},
      signingKey: env.signingKey,
    } as never);

    const state = await providers.publicDataProvider.queryContractState(env.contractAddress);
    const ledgerState = state ? contractModule.ledger(state.data) : null;

    console.log(`[upgrade] joined contract=${found.deployTxData.public.contractAddress}`);
    console.log(`[upgrade] compiled view=${env.version}`);
    console.log(
      `[upgrade] maintenance interfaces increment=${typeof found.circuitMaintenanceTx.increment} replaceAuthority=${typeof found.contractMaintenanceTx.replaceAuthority}`,
    );
    console.log(
      `[upgrade] ledger counter=${ledgerState?.counter ?? 'n/a'} step=${ledgerState?.step ?? 'n/a'}`,
    );
  } finally {
    await stopWallet(walletBundle);
  }
};

run().catch((error) => {
  console.error('[upgrade] inspect failed', error);
  process.exitCode = 1;
});
