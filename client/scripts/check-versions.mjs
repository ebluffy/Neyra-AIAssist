// Fails when package.json, tauri.conf.json, Cargo.toml and Cargo.lock disagree,
// or when an optional release tag (client-vX.Y.Z[-pre]) names another version.
// Usage (from client/): node scripts/check-versions.mjs [client-v0.1.0]
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function readVersions(root) {
  const read = (file) => readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');
  const cargo = read('src-tauri/Cargo.toml').match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  const lock = read('src-tauri/Cargo.lock').match(/name = "neyra-client"\r?\nversion = "([^"]+)"/);
  return {
    'package.json': JSON.parse(read('package.json')).version,
    'tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version,
    'Cargo.toml': cargo?.[1],
    'Cargo.lock': lock?.[1],
  };
}

export function invokedDirectly(metaUrl, argv1) {
  return metaUrl === pathToFileURL(argv1).href;
}

export function versionProblems(versions, tag) {
  const problems = [];
  for (const [file, version] of Object.entries(versions)) {
    if (!version) problems.push(`${file}: version not found`);
    else if (!SEMVER.test(version)) problems.push(`${file}: "${version}" is not SemVer`);
  }
  const distinct = new Set(Object.values(versions));
  if (distinct.size > 1) problems.push(`versions differ: ${JSON.stringify(versions)}`);
  if (tag !== undefined) {
    const match = /^client-v(.+)$/.exec(tag);
    if (!match) problems.push(`tag "${tag}" must look like client-vX.Y.Z`);
    else if (!distinct.has(match[1]) || distinct.size > 1) problems.push(`tag ${tag} does not match file version(s) ${[...distinct].join(', ')}`);
  }
  return problems;
}

if (invokedDirectly(import.meta.url, process.argv[1])) {
  const root = resolve(import.meta.dirname, '..');
  const problems = versionProblems(readVersions(root), process.argv[2]);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('versions in sync');
}
