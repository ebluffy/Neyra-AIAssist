# Desktop updater (Tauri 2) — test chain

Production GitHub Releases signing secrets may be absent. Signature verification stays **on**. Do not publish a public release without an owner command.

## Keys

- Public key is embedded in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
- **Current pubkey is a CI/dev test placeholder** (minisign key id in the pubkey comment: `1AAFC11FB991FBB6`). Builds signed against this key are **not** a beta update channel and must **not** be used to verify N→N+1.
- The matching private half is **not** in the repository. For production, the **owner** runs `tauri signer generate` on a trusted machine, puts the public half in `tauri.conf.json`, and stores only the private half + password in GitHub Secrets:
  - `TAURI_SIGNING_PRIVATE_KEY`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- Until that owner key replaces the placeholder, CI installers are install-only test artifacts (reinstall required for any “update”).

```sh
npm run tauri -- signer generate -w ./neyra-updater.key
# put .pub into tauri.conf.json; never commit the private key
```

If the public key changes, every installed client must be upgraded once via a trusted installer before updater works again.

## Packages

| Target | When |
|---|---|
| NSIS `.exe` | Windows CI / release |
| `.deb` | Linux CI / release |
| AppImage | Linux CI / release (`createUpdaterArtifacts` stays **false** in PR until owner signing secrets exist) |

Desktop PR CI builds unsigned installers as artifacts. **`.github/workflows/client-release.yml` does not exist yet** — it will appear in step 8 on `codex/desktop-beta-ship`. Until then there is no release workflow in this tree.

## In-app check (after step 8)

The UI button **Проверить обновления** and webview updater permissions arrive with ship (step 8). Right now the webview has **no** `updater:*` capability; check/install must go through Rust when ship lands.

## Manual N→N+1 check (owner, after production key + step 8 UI)

1. Replace placeholder pubkey with the owner production pubkey; put private key in Secrets.
2. Build version N signed; install from a trusted artifact (not placeholder-key CI builds as a permanent channel).
3. Publish (private/draft OK) version N+1 artifacts + `latest.json` to the configured endpoint.
4. In client (after step 8): **Проверить обновления** → confirm install → restart.
5. Confirm server URL, keyring token, theme, device_id and permissions survive.
6. AppImage: confirm original AppImage path is preserved and child processes do not inherit AppImage `LD_LIBRARY_PATH` (Owyx block).

## Endpoint

Default: `https://github.com/ebluffy/Neyra-AIAssist/releases/latest/download/latest.json`

Override only with a same-trust HTTPS URL that serves signed updater metadata.
