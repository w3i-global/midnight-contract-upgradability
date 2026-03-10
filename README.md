# Contract Upgradability Example

This example is the ShieldUSD research harness for Midnight contract maintenance.

It intentionally starts small:

- deploys a minimal counter contract with an explicit Contract Maintenance Authority (CMA)
- records the deployed address plus the CMA verifying key
- re-joins the deployment using `findDeployedContract(...)` so later subtasks can test verifier-key replacement and authority rotation on the same address

Versioned contracts:

- `contracts/upgradable-counter-v1.compact` increments by `step`
- `contracts/upgradable-counter-v2.compact` increments by `step + 1`

`v2` keeps the same circuit names and argument shapes so a later verifier-key swap can test behavior changes without introducing ABI drift.

## Environment

Required:

```bash
export MN_UPGRADE_NETWORK=preprod
export MN_UPGRADE_WALLET_MNEMONIC="<funded bip39 mnemonic>"
```

Optional:

```bash
export MN_UPGRADE_SIGNING_KEY="<existing maintenance signing key>"
export MN_UPGRADE_NEW_SIGNING_KEY="<new maintenance signing key>"
export MN_UPGRADE_INITIAL_COUNTER=0
export MN_UPGRADE_INITIAL_STEP=1
export MN_UPGRADE_CONTRACT_ADDRESS="<existing deployed address>"
export MN_UPGRADE_CONTRACT_VERSION=v1
```

Endpoint overrides are also supported:

- `MN_UPGRADE_INDEXER`
- `MN_UPGRADE_INDEXER_WS`
- `MN_UPGRADE_NODE`
- `MN_UPGRADE_NODE_WS`
- `MN_UPGRADE_PROOF_SERVER`
- `MN_UPGRADE_PRIVATE_STATE_STORE`

## Install

```bash
npm install
```

## Create `.env`

```bash
cp .env.example .env
```

All scripts load `.env` automatically via `dotenv` when they import `src/config.ts`.

Minimum values to fill in before the first deploy:

- `MN_UPGRADE_WALLET_MNEMONIC`
- optionally `MN_UPGRADE_NETWORK` if you want `preview` instead of `preprod`

After deployment, update `.env` with:

- `MN_UPGRADE_SIGNING_KEY`
- `MN_UPGRADE_CONTRACT_ADDRESS`
- later `MN_UPGRADE_CONTRACT_VERSION=v2` once the verifier-key update succeeds

## Manual Compact Compile

Run these manually in your terminal:

```bash
npm run compile:v1
npm run compile:v2
```

Use `:skip-zk` only for quick iteration. Full verifier-key maintenance testing needs the full ZK artifacts.

## Deploy Version A With Explicit CMA

```bash
npm run deploy:v1
```

What it does:

1. loads the `v1` managed contract artifacts
2. samples or reuses a maintenance signing key
3. deploys with `deployContract(..., { signingKey })`
4. writes a non-secret manifest to `data/latest-deployment.json`

Important:

- if `MN_UPGRADE_SIGNING_KEY` is not set, the script prints the sampled signing key once
- store that key securely; the manifest only stores the corresponding verifying key

## Re-join Existing Deployment

```bash
export MN_UPGRADE_CONTRACT_ADDRESS="<deployed address>"
export MN_UPGRADE_CONTRACT_VERSION=v1
npm run inspect
```

This confirms:

- the deployment can be re-opened locally
- maintenance interfaces are exposed on the found contract object
- the ledger state is readable through the compiled contract view

## Update Existing Deployment To Version B

After a `v1` deployment exists and both versions have been compiled with full ZK artifacts:

```bash
export MN_UPGRADE_CONTRACT_ADDRESS="<deployed address>"
export MN_UPGRADE_SIGNING_KEY="<current maintenance signing key>"
npm run update:v2
```

What it does:

1. verifies `getCounter` and `getStep` verifier keys are unchanged between `v1` and `v2`
2. verifies `increment` verifier keys differ
3. joins the deployed contract with `v1`
4. calls baseline `increment()` once
5. removes the deployed `increment` verifier key
6. inserts the `v2` `increment` verifier key
7. rejoins the same address with `v2`
8. calls `increment()` again and prints the before/after deltas

Expected behavior:

- baseline delta should equal `step`
- post-update delta should equal `step + 1`
- contract address should remain unchanged

## Rotate The Maintenance Authority

After the contract is on the desired version:

```bash
export MN_UPGRADE_CONTRACT_ADDRESS="<deployed address>"
export MN_UPGRADE_SIGNING_KEY="<current maintenance signing key>"
export MN_UPGRADE_CONTRACT_VERSION=v2
npm run rotate:authority
```

If `MN_UPGRADE_NEW_SIGNING_KEY` is omitted, the script samples one and prints it once.

What it does:

1. joins the existing deployment with the current authority
2. calls `replaceAuthority(newSigningKey)`
3. rejoins the same address with the new signing key
4. updates `data/latest-deployment.json` with the new authority verifying key

## Planned Follow-up

Open manual validation points remain:

1. live network execution still needs a funded wallet mnemonic and maintenance signing key
2. proving the **old** authority can no longer perform maintenance after rotation still requires a deliberate follow-up probe on a disposable deployment or sacrificial circuit key
