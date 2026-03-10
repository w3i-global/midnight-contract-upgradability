import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(rootDir, 'data');
export const manifestPath = path.resolve(dataDir, 'latest-deployment.json');

export interface DeploymentManifest {
  readonly contractAddress: string;
  readonly txId: string | null;
  readonly blockHeight: number | null;
  readonly compiledVersion: 'v1' | 'v2';
  readonly initialCounter: string;
  readonly initialStep: string;
  readonly maintenanceVerifyingKey: string;
  readonly network: 'preview' | 'preprod';
}

export const readManifest = (): DeploymentManifest | null => {
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as DeploymentManifest;
};

export const writeManifest = (manifest: DeploymentManifest) => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
};
