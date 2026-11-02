// Checks that updater .sig files are bound to the expected app version.
// This reads the signed trusted comment only; the plugin does the crypto check.
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

if (invokedDirectly(import.meta.url, process.argv[1])) {
  const [version, ...files] = process.argv.slice(2);
  if (!version || files.length === 0) {
    console.error('usage: check-updater-signature.mjs <version> <file.sig>...');
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const found = signedVersion(readFileSync(file, 'utf8'));
    if (found !== version) {
      console.error(`${file}: signed version is ${found ?? 'missing'}, expected ${version}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(`${files.length} signature(s) bound to ${version}`);
}
