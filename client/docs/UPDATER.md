# Desktop updater (Tauri 2)

Signature checking is always on. The client never installs a file whose
signature does not verify against the public key built into the app. Release
CI publishes only after every platform build succeeds.

## How it works

- Rust commands in `src-tauri/src/updater.rs`: `update_state`, `update_save`,
  `update_check`, `update_install`, `update_restart`. The web UI only calls these.
  The JS updater plugin and the `updater:default` permission are not used.
- Settings live in `Documents/Neyra/settings/updater.json` (versioned):
  `channel` (`stable` default, or `beta`) and `auto_check` (default on, checked
  once when the Server tab opens). Installing never changes `settings/app.json`,
  the keyring token, permissions or audit.
- `tauri.conf.json` -> `plugins.updater`:
  - `pubkey`: public key of the signing key. Currently a CI/dev placeholder (minisign key id `1AAFC11FB991FBB6`) whose
    private half is not stored anywhere. Builds cannot be signed for it, so it is
    not a working update channel. The owner replaces it before the first real
    release.
  - `requireSignedVersion: true`: the version in the signed trusted comment must
    equal the version announced in `latest.json`. This blocks a rollback where an
    attacker serves a new version number with an old, validly signed build.
    Signatures without a version are rejected.
  - No `dangerous*` flags and no `allowDowngrades`. A test fails if one appears.
- Only newer versions are offered (SemVer). Same or older versions are ignored.
- `bundle.createUpdaterArtifacts` is `false` so PR CI works without secrets. The
  release workflow turns it on with `src-tauri/tauri.release.conf.json`.

## Channels and endpoints

| Channel | `latest.json` URL |
|---|---|
| stable | `https://github.com/ebluffy/Neyra-AIAssist/releases/latest/download/latest.json` |
| beta | `https://github.com/ebluffy/Neyra-AIAssist/releases/download/client-beta/latest.json` |

GitHub's `latest` never points at prereleases or drafts. A `client-v*-beta.*`
release is published as a prerelease and does not update the stable `latest`
endpoint. After publishing a release, CI copies its `latest.json` into the
rolling `client-beta` prerelease if its version is newer than the current feed.
Stable releases also advance this feed, so beta users receive stable versions
when they are newer. Manifest asset URLs still point to the original release.

Both URLs are hardcoded HTTPS. There is no user-editable endpoint.

## Versions

One SemVer in four places: `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (`neyra-client`). Pre-release
suffixes such as `0.2.0-beta.1` are allowed. `npm run check:versions` checks them
and runs in PR CI. The release workflow also requires tag `client-v<version>`.

## Signing keys

Owner setup and release steps: [docs/RELEASE.md](../../docs/RELEASE.md).
Keep a backup of the production key. If it is lost, installed clients cannot
update and need a manual reinstall. Changing `pubkey` has the same effect.

Production secrets are not available to this repo yet. Until they are set, the
release workflow stops in its preflight job. It does not build unsigned releases.

Test key: `src-tauri/updater-test/test.key` is committed on purpose, has no
password, and signs only test fixtures. Its public half is never allowed in
`tauri.conf.json` (a Rust test and the release preflight both check this).

## Test chain

All of this runs without secrets:

| What | Where | Command |
|---|---|---|
| Real plugin, local HTTP server, N=0.1.0 to N+1=0.1.1: valid install, same/older version, untrusted key, tampered file, truncated/garbage/empty signature, wrong public key, announced version differs from signed version, unversioned signature, corrupt manifest, missing file, non-ELF payload. After every rejection the old AppImage must be unchanged. | `src-tauri/tests/updater_chain.rs` (Linux) | `cargo test --locked` |
| Real `tauri build` output, signed with the test key, installed over an older version by the same plugin, then the same file tampered | same file, ignored by default | see below |
| Config guards: HTTPS endpoints, no `dangerous*`, `requireSignedVersion`, shipped key is not the test key | `src-tauri/src/updater.rs` tests | `cargo test --locked` |
| Version sync, release overlay, signature version binding | `scripts/release-checks.test.mjs` | `npm run test:scripts` |
| Beta feed SemVer ordering, update/skip decisions and tag/manifest validation | `scripts/beta-feed.test.mjs` | `npm run test:scripts` |
| Fixture regeneration (new throwaway "untrusted" key every run) | `scripts/updater-fixtures.mjs` | `npm run updater:fixtures` |

Real-build check:

```sh
cd client
export TAURI_SIGNING_PRIVATE_KEY="$(cat src-tauri/updater-test/test.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build -- --config src-tauri/tauri.release.conf.json --bundles appimage
cd src-tauri
NEYRA_REAL_APPIMAGE=target/release/bundle/appimage/Neyra_<version>_amd64.AppImage \
NEYRA_REAL_VERSION=<version> cargo test --locked --test updater_chain -- --ignored
```

`tauri build` writes `Neyra_<version>_amd64.AppImage` plus `.sig` directly (no
`.tar.gz`) and records `version:<x>` in the signature. This was run on the cloud
VM (Ubuntu, Rust stable) with the test key: the signature was bound to the
version, the plugin installed it and rejected a tampered copy.

Not covered by automation (owner, on real machines):

- Windows NSIS update (passive installer, app restart) and SmartScreen.
- A GitHub-hosted release: download over the real endpoints, `latest.json` from
  tauri-action and the rolling beta feed.
- Restart after install on KDE Wayland; AppImage path preserved across update.
- `.deb` update on Debian/Ubuntu (the plugin calls `pkexec dpkg -i`; not on Arch).

## Release workflow

`.github/workflows/client-release.yml`, trigger: tag `client-v*` or manual run.

1. Preflight: version equals tag, both signing secrets are set, public key
   is not a placeholder or the test key, no `dangerous*` flags,
   `requireSignedVersion` is true. Fails with a clear message otherwise.
2. Build on `windows-latest` (NSIS) and `ubuntu-22.04` (AppImage + deb) with
   `tauri-apps/tauri-action`: draft release, `prerelease` when the tag has a
   `-suffix`, updater `latest.json` uploaded by the action. Builds run serially
   so each platform's updater entry is retained.
3. Every `.sig` must carry the release version and the configured public key ID,
   else the job fails. Only after both builds succeed does the final job publish
   the release automatically. It then creates or updates `client-beta/latest.json`
   when the published version is newer than the feed's current version.
   Feed lookup/download errors or invalid manifest versions stop the update.

Code signing (Authenticode) is not set up.

## Manual N to N+1 check

1. Install build N (signed). Set server URL, token, theme, permissions.
2. Publish N+1 as a draft or private test release; point a test build at it.
3. Server tab -> Updates: check, install, restart.
4. Confirm settings, token, device id and permissions survived.
5. AppImage: confirm the original file path was replaced and child processes
   still get a clean environment (no AppImage `LD_LIBRARY_PATH`).
