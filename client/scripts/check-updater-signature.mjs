// Checks updater signature version and signing key ID before publication.
// The plugin verifies the actual cryptographic signature during installation.
// Usage (from client/): node scripts/check-updater-signature.mjs <version> <file.sig>...
import { readFileSync } from 'node:fs';
import { invokedDirectly } from './check-versions.mjs';

export function signedVersion(sigFileText) {
  let text;
  try {
    text = Buffer.from(sigFileText.trim(), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
  const comment = text.split('\n').find((line) => line.startsWith('trusted comment: '));
  if (!comment) return undefined;
  return comment
    .slice('trusted comment: '.length)
    .split('\t')
    .find((field) => field.startsWith('version:'))
    ?.slice('version:'.length);
}

function minisignKeyId(text) {
  const line = text.split(/\r?\n/)[1];
  if (!line || !/^[A-Za-z0-9+/]+={0,2}$/.test(line)) return undefined;
  const bytes = Buffer.from(line, 'base64');
  if (bytes.length < 10 || bytes[0] !== 0x45 || ![0x44, 0x64].includes(bytes[1])) return undefined;
  return bytes.subarray(2, 10).toString('hex');
}

export function signatureKeyId(sigFileText) {
  return minisignKeyId(Buffer.from(sigFileText.trim(), 'base64').toString('utf8'));
}

export function publicKeyId(pubkey) {
  return minisignKeyId(Buffer.from(pubkey.trim(), 'base64').toString('utf8'));
}

if (invokedDirectly(import.meta.url, process.argv[1])) {
  const [version, ...files] = process.argv.slice(2);
  if (!version || files.length === 0) {
    console.error('usage: check-updater-signature.mjs <version> <file.sig>...');
    process.exit(2);
  }
  const pubkey = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).plugins.updater.pubkey;
  const expectedKeyId = publicKeyId(pubkey);
  if (!expectedKeyId) {
    console.error('::error::plugins.updater.pubkey has no valid minisign key ID');
    process.exit(1);
  }
  let failed = false;
  for (const file of files) {
    const signature = readFileSync(file, 'utf8');
    const found = signedVersion(signature);
    if (found !== version) {
      console.error(`::error file=${file}::Signed version is ${found ?? 'missing'}, expected ${version}`);
      failed = true;
    }
    const keyId = signatureKeyId(signature);
    if (keyId !== expectedKeyId) {
      console.error(`::error file=${file}::Signature key ID ${keyId ?? 'missing'} does not match plugins.updater.pubkey (${expectedKeyId})`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(`${files.length} signature(s) bound to ${version}`);
}
