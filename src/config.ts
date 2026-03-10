import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

export type SupportedNetwork = 'preview' | 'preprod';
export type ContractVersion = 'v1' | 'v2';

export interface UpgradeConfig {
  readonly network: SupportedNetwork;
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly nodeWs: string;
  readonly proofServer: string;
  readonly privateStateStoreName: string;
}

export interface UpgradeEnv {
  readonly network: SupportedNetwork;
  readonly mnemonic: string;
  readonly signingKey?: string;
  readonly newSigningKey?: string;
  readonly contractAddress?: string;
  readonly version: ContractVersion;
  readonly initialCounter: bigint;
  readonly initialStep: bigint;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const contractArtifacts = {
  v1: {
    contractName: 'upgradable-counter-v1',
    managedPath: path.resolve(rootDir, 'contracts', 'managed', 'upgradable-counter-v1'),
  },
  v2: {
    contractName: 'upgradable-counter-v2',
    managedPath: path.resolve(rootDir, 'contracts', 'managed', 'upgradable-counter-v2'),
  },
} as const;

const previewConfig: UpgradeConfig = {
  network: 'preview',
  indexer: 'https://indexer.preview.midnight.network/api/v3/graphql',
  indexerWS: 'wss://indexer.preview.midnight.network/api/v3/graphql/ws',
  node: 'https://rpc.preview.midnight.network',
  nodeWs: 'wss://rpc.preview.midnight.network',
  proofServer: 'https://lace-proof-pub.preview.midnight.network',
  privateStateStoreName: 'upgradable-counter-private-state-preview',
};

const preprodConfig: UpgradeConfig = {
  network: 'preprod',
  indexer: 'https://indexer.preprod.midnight.network/api/v3/graphql',
  indexerWS: 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
  node: 'https://rpc.preprod.midnight.network',
  nodeWs: 'wss://rpc.preprod.midnight.network',
  proofServer: 'https://lace-proof-pub.preprod.midnight.network',
  privateStateStoreName: 'upgradable-counter-private-state-preprod',
};

const readEnvString = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
};

const normalizeNetwork = (value: string): SupportedNetwork => {
  if (value === 'preview' || value === 'preprod') {
    return value;
  }
  throw new Error(`Unsupported MN_UPGRADE_NETWORK value: ${value}`);
};

const normalizeVersion = (value: string | undefined): ContractVersion => {
  if (!value || value === 'v1') return 'v1';
  if (value === 'v2') return 'v2';
  throw new Error(`Unsupported MN_UPGRADE_CONTRACT_VERSION value: ${value}`);
};

const parseUint64 = (name: string, raw: string | undefined, fallback: bigint): bigint => {
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be an unsigned integer string`);
  }
  const value = BigInt(raw);
  const max = (1n << 64n) - 1n;
  if (value < 0n || value > max) {
    throw new Error(`${name} must fit in Uint<64>`);
  }
  return value;
};

export const loadUpgradeEnv = (): UpgradeEnv => {
  const network = normalizeNetwork(readEnvString('MN_UPGRADE_NETWORK') ?? 'preprod');
  const mnemonic = readEnvString('MN_UPGRADE_WALLET_MNEMONIC');
  if (!mnemonic) {
    throw new Error('MN_UPGRADE_WALLET_MNEMONIC is required (BIP-39 mnemonic)');
  }

  return {
    network,
    mnemonic,
    signingKey: readEnvString('MN_UPGRADE_SIGNING_KEY'),
    newSigningKey: readEnvString('MN_UPGRADE_NEW_SIGNING_KEY'),
    contractAddress: readEnvString('MN_UPGRADE_CONTRACT_ADDRESS'),
    version: normalizeVersion(readEnvString('MN_UPGRADE_CONTRACT_VERSION')),
    initialCounter: parseUint64('MN_UPGRADE_INITIAL_COUNTER', readEnvString('MN_UPGRADE_INITIAL_COUNTER'), 0n),
    initialStep: parseUint64('MN_UPGRADE_INITIAL_STEP', readEnvString('MN_UPGRADE_INITIAL_STEP'), 1n),
  };
};

export const resolveConfig = (env: UpgradeEnv): UpgradeConfig => {
  const base = env.network === 'preview' ? previewConfig : preprodConfig;
  const config: UpgradeConfig = {
    network: env.network,
    indexer: readEnvString('MN_UPGRADE_INDEXER') ?? base.indexer,
    indexerWS: readEnvString('MN_UPGRADE_INDEXER_WS') ?? base.indexerWS,
    node: readEnvString('MN_UPGRADE_NODE') ?? base.node,
    nodeWs: readEnvString('MN_UPGRADE_NODE_WS') ?? base.nodeWs,
    proofServer: readEnvString('MN_UPGRADE_PROOF_SERVER') ?? base.proofServer,
    privateStateStoreName: readEnvString('MN_UPGRADE_PRIVATE_STATE_STORE') ?? base.privateStateStoreName,
  };
  setNetworkId(env.network);
  return config;
};
