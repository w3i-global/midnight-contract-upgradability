import { type ContractAddress } from '@midnight-ntwrk/compact-runtime';
import { nativeToken } from '@midnight-ntwrk/ledger-v7';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';
import type { UpgradeConfig, SupportedNetwork } from './config.js';

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

export interface WalletBundle {
  readonly wallet: WalletFacade;
  readonly shieldedSecretKeys: ledger.ZswapSecretKeys;
  readonly dustSecretKey: ledger.DustSecretKey;
  readonly unshieldedKeystore: ReturnType<typeof createKeystore>;
  readonly network: SupportedNetwork;
}

export type UpgradeProviders = any;

export interface WalletStateSnapshot {
  readonly address: string;
  readonly shieldedBalance: bigint;
  readonly unshieldedBalance: bigint;
  readonly dustBalance: bigint;
}

const NIGHT_DECIMALS = 6;
const DUST_DECIMALS = 15;

const formatUnits = (value: bigint, decimals: number): string => {
  const isNegative = value < 0n;
  const magnitude = isNegative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = magnitude / base;
  const fraction = magnitude % base;
  return `${isNegative ? '-' : ''}${whole.toString()}.${fraction.toString().padStart(decimals, '0')}`;
};

const signTransactionIntents = (
  tx: { intents?: Map<number, any> },
  signFn: (payload: Uint8Array) => ledger.Signature,
  proofMarker: 'proof' | 'pre-proof',
): void => {
  if (!tx.intents || tx.intents.size === 0) return;

  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    if (!intent) continue;

    const cloned = ledger.Intent.deserialize<ledger.SignatureEnabled, ledger.Proofish, ledger.PreBinding>(
      'signature',
      proofMarker,
      'pre-binding',
      intent.serialize(),
    );

    const signature = signFn(cloned.signatureData(segment));

    if (cloned.fallibleUnshieldedOffer) {
      const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
        (_input: ledger.UtxoSpend, index: number) => cloned.fallibleUnshieldedOffer!.signatures.at(index) ?? signature,
      );
      cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(sigs);
    }

    if (cloned.guaranteedUnshieldedOffer) {
      const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
        (_input: ledger.UtxoSpend, index: number) => cloned.guaranteedUnshieldedOffer!.signatures.at(index) ?? signature,
      );
      cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
    }

    tx.intents.set(segment, cloned);
  }
};

const waitForSync = (wallet: WalletFacade) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.tap((state) => {
        console.log('[upgrade] sync progress', {
          shielded: state.shielded.progress,
          unshielded: state.unshielded.progress,
          dust: state.dust.progress,
        });
      }),
      Rx.filter((state) => state.isSynced),
    ),
  );

const waitForFunds = (wallet: WalletFacade) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(10_000),
      Rx.filter((state) => state.isSynced),
      Rx.map((state) => ({
        shielded: state.shielded.balances[nativeToken().raw] ?? 0n,
        unshielded: state.unshielded.balances?.[nativeToken().raw] ?? 0n,
        dust: state.dust.walletBalance?.(new Date()) ?? 0n,
      })),
      Rx.tap((balances) => {
        console.log(
          `[upgrade] balance check: shielded=${balances.shielded.toString()} ` +
            `unshielded=${formatUnits(balances.unshielded, NIGHT_DECIMALS)} tNIGHT ` +
            `dust=${formatUnits(balances.dust, DUST_DECIMALS)} tDUST`,
        );
      }),
      Rx.filter((balances) => balances.shielded > 0n || balances.unshielded > 0n || balances.dust > 0n),
    ),
  );

const deriveKeysFromMnemonic = async (mnemonic: string) => {
  const { mnemonicToSeedSync } = await import('@scure/bip39');
  const normalized = mnemonic.normalize('NFKD').trim();
  const seed = mnemonicToSeedSync(normalized);
  const hdWallet = HDWallet.fromSeed(seed);
  if (hdWallet.type !== 'seedOk') {
    throw new Error('Failed to initialize HD wallet from mnemonic');
  }

  const derivation = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derivation.type !== 'keysDerived') {
    throw new Error('Failed to derive wallet keys');
  }

  hdWallet.hdWallet.clear();
  return {
    zswap: derivation.keys[Roles.Zswap],
    night: derivation.keys[Roles.NightExternal],
    dust: derivation.keys[Roles.Dust],
  };
};

const buildWalletConfiguration = (config: UpgradeConfig) => ({
  networkId: config.network,
  costParameters: {
    additionalFeeOverhead: 300_000_000_000_000_000n,
    feeBlocksMargin: 5,
  },
  relayURL: new URL(config.nodeWs),
  provingServerUrl: new URL(config.proofServer),
  indexerClientConnection: {
    indexerHttpUrl: config.indexer,
    indexerWsUrl: config.indexerWS,
  },
  indexerUrl: config.indexerWS,
});

export const buildWallet = async (config: UpgradeConfig, mnemonic: string): Promise<WalletBundle> => {
  const keys = await deriveKeysFromMnemonic(mnemonic);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys.zswap);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys.dust);
  const unshieldedKeystore = createKeystore(keys.night, config.network);
  const walletConfig = buildWalletConfiguration(config);

  const shieldedWallet = ShieldedWallet(walletConfig).startWithSecretKeys(shieldedSecretKeys as any);
  const dustWallet = DustWallet(walletConfig).startWithSecretKey(
    dustSecretKey as any,
    ledger.LedgerParameters.initialParameters().dust as unknown as Parameters<
      ReturnType<typeof DustWallet>['startWithSecretKey']
    >[1],
  );
  const unshieldedWallet = UnshieldedWallet({
    ...walletConfig,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  }).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));

  const wallet = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
  await wallet.start(shieldedSecretKeys as any, dustSecretKey as any);

  return {
    wallet,
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
    network: config.network,
  };
};

export const ensureWalletReady = async (
  wallet: WalletFacade,
  network: SupportedNetwork,
): Promise<WalletStateSnapshot> => {
  await waitForSync(wallet);
  const snapshot = await getWalletSnapshot(wallet, network);
  if (snapshot.shieldedBalance === 0n && snapshot.unshieldedBalance === 0n && snapshot.dustBalance === 0n) {
    await waitForFunds(wallet);
    return getWalletSnapshot(wallet, network);
  }
  return snapshot;
};

export const getWalletSnapshot = async (
  wallet: WalletFacade,
  network: SupportedNetwork,
): Promise<WalletStateSnapshot> => {
  const state = await Rx.firstValueFrom(wallet.state());
  const shieldedBalance = state.shielded.balances[nativeToken().raw] ?? 0n;
  const unshieldedBalance = state.unshielded.balances?.[nativeToken().raw] ?? 0n;
  const dustBalance = state.dust.walletBalance?.(new Date()) ?? 0n;
  const address = MidnightBech32m.encode(network, state.shielded.address).asString();
  console.log(`[upgrade] shielded address: ${address}`);
  console.log(
    `[upgrade] balances: shielded=${shieldedBalance.toString()} ` +
      `unshielded=${formatUnits(unshieldedBalance, NIGHT_DECIMALS)} tNIGHT ` +
      `dust=${formatUnits(dustBalance, DUST_DECIMALS)} tDUST`,
  );
  return { address, shieldedBalance, unshieldedBalance, dustBalance };
};

export const createProviders = async (
  wallet: WalletFacade,
  config: UpgradeConfig,
  keys: { shieldedSecretKeys: ledger.ZswapSecretKeys; dustSecretKey: ledger.DustSecretKey },
  unshieldedKeystore: ReturnType<typeof createKeystore>,
  zkConfigPath: string,
): Promise<UpgradeProviders> => {
  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((value) => value.isSynced)));
  const walletProvider = {
    getCoinPublicKey() {
      return state.shielded.coinPublicKey.toHexString();
    },
    getEncryptionPublicKey() {
      return state.shielded.encryptionPublicKey.toHexString();
    },
    async balanceTx(tx: unknown) {
      const recipe = await wallet.balanceUnboundTransaction(
        tx as never,
        { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
        { ttl: new Date(Date.now() + 60 * 60 * 1000) },
      );

      const signFn = (payload: Uint8Array) => unshieldedKeystore.signData(payload);
      if ((recipe as any).baseTransaction) {
        signTransactionIntents((recipe as any).baseTransaction, signFn, 'proof');
      }
      if ((recipe as any).balancingTransaction) {
        signTransactionIntents((recipe as any).balancingTransaction, signFn, 'pre-proof');
      }
      return wallet.finalizeRecipe(recipe as never) as Promise<any>;
    },
    submitTx(tx: unknown) {
      return wallet.submitTransaction(tx as never) as Promise<any>;
    },
  };

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: config.privateStateStoreName,
      walletProvider: walletProvider as any,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider: new NodeZkConfigProvider<any>(zkConfigPath),
    proofProvider: httpClientProofProvider(config.proofServer, new NodeZkConfigProvider<any>(zkConfigPath)),
    walletProvider: walletProvider as any,
    midnightProvider: walletProvider as any,
  } as UpgradeProviders;
};

export const assertContractAddress = (address: string): ContractAddress => {
  if (typeof address !== 'string' || address.length === 0) {
    throw new Error(`Unexpected contract address format: ${String(address)}`);
  }
  return address as ContractAddress;
};

export const stopWallet = async (bundle?: WalletBundle) => {
  if (!bundle) return;
  await bundle.wallet.stop();
};
