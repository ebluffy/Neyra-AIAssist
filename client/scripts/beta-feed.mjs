import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function compareVersions(a, b) {
  const parse = (version) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
    if (!match) throw new Error(`Invalid release version: ${version}`);
    return [match.slice(1, 4).map(Number), match[4]?.split('.')];
  };
  const [numbersA, preA] = parse(a);
  const [numbersB, preB] = parse(b);
  for (let i = 0; i < 3; i++) {
    if (numbersA[i] !== numbersB[i]) return numbersA[i] > numbersB[i] ? 1 : -1;
  }
  if (!preA || !preB) return preA ? -1 : preB ? 1 : 0;
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    if (preA[i] === undefined) return -1;
    if (preB[i] === undefined) return 1;
    const numericA = /^\d+$/.test(preA[i]);
    const numericB = /^\d+$/.test(preB[i]);
    if (numericA && numericB) {
      const difference = BigInt(preA[i]) - BigInt(preB[i]);
      if (difference) return difference > 0 ? 1 : -1;
    } else if (numericA !== numericB) {
      return numericA ? -1 : 1;
    } else if (preA[i] !== preB[i]) {
      return preA[i] > preB[i] ? 1 : -1;
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [tag, candidatePath, currentPath] = process.argv.slice(2);
    const candidate = JSON.parse(readFileSync(candidatePath, 'utf8')).version;
    if (tag !== `client-v${candidate}`) throw new Error(`Manifest version ${candidate} does not match ${tag}`);
    const current = currentPath ? JSON.parse(readFileSync(currentPath, 'utf8')).version : undefined;
    console.log(current && compareVersions(candidate, current) <= 0 ? 'skip' : 'update');
  } catch (error) {
    console.error(`::error::Beta feed: ${error.message}`);
    process.exitCode = 1;
  }
}
