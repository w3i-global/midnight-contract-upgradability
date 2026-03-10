import { findDeployedContract, verifierKeysEqual, verifyContractState } from '@midnight-ntwrk/midnight-js-contracts';
import type { ContractAddress } from '@midnight-ntwrk/compact-runtime';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import type { ContractVersion, UpgradeConfig, UpgradeEnv } from './config.js';
import { loadCompiledContract } from './contract-loader.js';
import { contractArtifacts } from './config.js';
import { readManifest } from './manifest.js';
import {
  assertContractAddress,
  buildWallet,
  createProviders,
  ensureWalletReady,
  stopWallet,
  type UpgradeProviders,
  type WalletBundle,
} from './providers.js';

export const PRIVATE_STATE_ID = 'upgradableCounterPrivateState';

export const resolveContractAddress = (env: UpgradeEnv): ContractAddress => {
  const manifest = readManifest();
  const address = env.contractAddress ?? manifest?.contractAddress;
  if (!address) {
    throw new Error('MN_UPGRADE_CONTRACT_ADDRESS is required or data/latest-deployment.json must exist');
  }
  return assertContractAddress(address);
};

export const resolveSigningKey = (env: UpgradeEnv): string => {
  if (!env.signingKey) {
    throw new Error('MN_UPGRADE_SIGNING_KEY is required for maintenance operations');
  }
  return env.signingKey;
};

export const createRuntime = async (
  config: UpgradeConfig,
  mnemonic: string,
  version: ContractVersion,
): Promise<{
  walletBundle: WalletBundle;
  providers: UpgradeProviders;
  compiledContract: any;
  contractModule: any;
}> => {
  const walletBundle = await buildWallet(config, mnemonic);
  await ensureWalletReady(walletBundle.wallet, config.network);
  const { compiledContract, contractModule, zkConfigPath } = await loadCompiledContract(version);
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
  return { walletBundle, providers, compiledContract, contractModule };
};

export const stopRuntime = async (walletBundle?: WalletBundle) => stopWallet(walletBundle);

export const joinDeployedContract = async (
  providers: UpgradeProviders,
  compiledContract: any,
  contractAddress: ContractAddress,
  signingKey?: string,
) =>
  findDeployedContract(providers as never, {
    contractAddress,
    compiledContract,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: {},
    signingKey,
  } as never);

export const readLedgerState = async (
  providers: UpgradeProviders,
  contractModule: any,
  contractAddress: ContractAddress,
) => {
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  return {
    raw: state,
    ledger: state ? contractModule.ledger(state.data) : null,
  };
};

export const verifyOnChainKeysMatch = async (
  providers: UpgradeProviders,
  circuitIds: string[],
  contractAddress: ContractAddress,
) => {
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!state) {
    throw new Error(`No contract state found at ${contractAddress}`);
  }
  const verifierKeys = await providers.zkConfigProvider.getVerifierKeys(circuitIds);
  verifyContractState(verifierKeys, state);
};

export const compareVersionVerifierKeys = async () => {
  const v1Provider = new NodeZkConfigProvider<'getCounter' | 'getStep' | 'increment'>(contractArtifacts.v1.managedPath);
  const v2Provider = new NodeZkConfigProvider<'getCounter' | 'getStep' | 'increment'>(contractArtifacts.v2.managedPath);
  const getCounterV1 = await v1Provider.getVerifierKey('getCounter');
  const getCounterV2 = await v2Provider.getVerifierKey('getCounter');
  const getStepV1 = await v1Provider.getVerifierKey('getStep');
  const getStepV2 = await v2Provider.getVerifierKey('getStep');
  const incrementV1 = await v1Provider.getVerifierKey('increment');
  const incrementV2 = await v2Provider.getVerifierKey('increment');
  return {
    getCounterEqual: verifierKeysEqual(getCounterV1, getCounterV2),
    getStepEqual: verifierKeysEqual(getStepV1, getStepV2),
    incrementEqual: verifierKeysEqual(incrementV1, incrementV2),
    incrementV2,
  };
};

export const getFinalizedTxId = (txData: unknown): string | null => {
  const value = txData as { txHash?: string; txId?: string; public?: { txHash?: string; txId?: string } };
  return value.public?.txHash ?? value.public?.txId ?? value.txHash ?? value.txId ?? null;
};
