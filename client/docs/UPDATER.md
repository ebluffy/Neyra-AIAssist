# Desktop updater (Tauri 2) — test chain

Production GitHub Releases signing secrets may be absent. Signature verification stays **on**. Do not publish a public release without an owner command.

## Keys

- Public key is embedded in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` (current value is a **CI/dev test key**).
- Private key and password live only in GitHub Secrets when ready:
  - `TAURI_SIGNING_PRIVATE_KEY` (literal key or path for build)
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- Generate a replacement (owner machine):

```sh
npm run tauri -- signer generate -w ./neyra-updater.key
# put .pub contents into tauri.conf.json; never commit the private key
```

If the public key changes, every installed client must be upgraded once via a trusted installer before N→N+1 updater works again.

## Packages

| Target | When |
|---|---|
| NSIS `.exe` | Windows CI / release |
| `.deb` | Linux CI / release |
| AppImage | Linux CI / release (`createUpdaterArtifacts` stays **false** in PR until signing secrets exist; enable for signed N→N+1) |

Desktop PR CI builds installers as artifacts. Release workflow (`.github/workflows/client-release.yml`) is draft-oriented: tag `client-v*` or `workflow_dispatch`; it signs only when secrets exist and still does **not** auto-publish unless the owner enables the release job.

## Manual N→N+1 check (owner)

1. Build version N signed with the private key; install.
2. Publish (private/draft OK) version N+1 artifacts + `latest.json` to the configured endpoint.
3. In client: **Проверить обновления** → install → restart.
4. Confirm server URL, keyring token, theme, device_id and permissions survive.
5. AppImage: confirm original AppImage path is preserved and child processes do not inherit AppImage `LD_LIBRARY_PATH` (Owyx block).

## Endpoint

Default: `https://github.com/ebluffy/Neyra-AIAssist/releases/latest/download/latest.json`

Override only with a same-trust HTTPS URL that serves signed updater metadata.
