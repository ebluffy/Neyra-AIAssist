//! N -> N+1 update chain against a local HTTP server with the real
//! tauri-plugin-updater: manifest fetch, version check, download, signature
//! check and in-place AppImage replacement. The mock app reports version 0.1.0.
//! Keys and signatures come from `updater-test/` (TEST ONLY).
#![cfg(target_os = "linux")]

use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri_plugin_updater::{Update, UpdaterExt};
use uuid::Uuid;

const TEST_PUBKEY: &str = include_str!("../updater-test/test.key.pub");
const PAYLOAD: &[u8] = include_bytes!("../updater-test/fixtures/payload.bin");
const TAMPERED: &[u8] = include_bytes!("../updater-test/fixtures/payload.tampered.bin");
const VALID_SIG: &str = include_str!("../updater-test/fixtures/payload.valid.sig");
const UNVERSIONED_SIG: &str = include_str!("../updater-test/fixtures/payload.unversioned.sig");
const UNTRUSTED_SIG: &str = include_str!("../updater-test/fixtures/payload.untrusted-key.sig");
const TRUNCATED_SIG: &str = include_str!("../updater-test/fixtures/payload.truncated.sig");
const GARBAGE_SIG: &str = include_str!("../updater-test/fixtures/payload.garbage.sig");
const INSTALLED_BEFORE: &[u8] =
    b"\x7fELF-installed-version-0.1.0-padding-padding-padding-padding-padding";

type Routes = Arc<Mutex<HashMap<String, Vec<u8>>>>;

struct Server {
    base: String,
    routes: Routes,
}

impl Server {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let routes: Routes = Arc::default();
        let shared = routes.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let routes = shared.clone();
                thread::spawn(move || {
                    let mut buffer = [0u8; 4096];
                    let n = stream.read(&mut buffer).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..n]);
                    let path = request.split_whitespace().nth(1).unwrap_or("/");
                    let found = routes.lock().unwrap().get(path).cloned();
                    let (status, body) = match found {
                        Some(body) => (200, body),
                        None => (404, b"not found".to_vec()),
                    };
                    let head = format!(
                        "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&body);
                });
            }
        });
        Self { base, routes }
    }

    fn put(&self, path: &str, body: Vec<u8>) {
        self.routes.lock().unwrap().insert(path.into(), body);
    }
}

fn platform_key() -> String {
    let arch = match std::env::consts::ARCH {
        "x86" => "i686",
        other => other,
    };
    format!("linux-{arch}")
}

struct Case {
    server: Server,
    app: tauri::App<MockRuntime>,
    installed: PathBuf,
}

impl Case {
    fn new(require_signed_version: bool, pubkey: &str) -> Self {
        Self::at_version("0.1.0", require_signed_version, pubkey)
    }

    fn at_version(current: &str, require_signed_version: bool, pubkey: &str) -> Self {
        let server = Server::start();
        let mut context = mock_context(noop_assets());
        context.package_info_mut().version = current.parse().unwrap();
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": pubkey.trim(),
                "endpoints": [format!("{}/latest.json", server.base)],
                "dangerousInsecureTransportProtocol": true,
                "requireSignedVersion": require_signed_version,
            }),
        );
        let app = mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let dir = std::env::temp_dir().join(format!("neyra-update-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let installed = dir.join("Neyra.AppImage");
        std::fs::write(&installed, INSTALLED_BEFORE).unwrap();
        Self {
            server,
            app,
            installed,
        }
    }

    fn release(&self, version: &str, signature: &str, artifact: &[u8]) {
        let manifest = serde_json::json!({
            "version": version,
            "notes": "test release",
            "pub_date": "2026-10-31T00:00:00Z",
            "platforms": { platform_key(): {
                "signature": signature,
                "url": format!("{}/Neyra.AppImage", self.server.base),
            } },
        });
        self.server
            .put("/latest.json", serde_json::to_vec(&manifest).unwrap());
        self.server.put("/Neyra.AppImage", artifact.to_vec());
    }

    fn check(&self) -> Result<Option<Update>, String> {
        let updater = self
            .app
            .handle()
            .updater_builder()
            .executable_path(&self.installed)
            .build()
            .map_err(|e| e.to_string())?;
        tauri::async_runtime::block_on(updater.check()).map_err(|e| e.to_string())
    }

    fn install(&self) -> Result<(), String> {
        let update = self.check()?.expect("an update must be offered");
        tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {}))
            .map_err(|e| e.to_string())
    }

    fn installed(&self) -> Vec<u8> {
        std::fs::read(&self.installed).unwrap()
    }

    fn assert_rejected_and_untouched(&self) {
        assert!(self.install().is_err());
        assert_eq!(self.installed(), INSTALLED_BEFORE, "old build must survive");
    }
}

#[test]
fn n_to_n_plus_one_replaces_the_old_appimage() {
    let case = Case::new(true, TEST_PUBKEY);
    case.release("0.1.1", VALID_SIG, PAYLOAD);
    let update = case.check().unwrap().expect("0.1.1 is newer than 0.1.0");
    assert_eq!(update.version, "0.1.1");
    assert_eq!(update.current_version, "0.1.0");
    case.install().unwrap();
    assert_eq!(case.installed(), PAYLOAD);
}

#[test]
fn same_or_older_version_offers_nothing() {
    for version in ["0.1.0", "0.0.9"] {
        let case = Case::new(true, TEST_PUBKEY);
        case.release(version, VALID_SIG, PAYLOAD);
        assert!(case.check().unwrap().is_none(), "{version}");
    }
}

#[test]
fn signature_from_an_untrusted_key_is_rejected() {
    let case = Case::new(true, TEST_PUBKEY);
    case.release("0.1.1", UNTRUSTED_SIG, PAYLOAD);
    case.assert_rejected_and_untouched();
}

#[test]
fn tampered_download_is_rejected() {
    let case = Case::new(true, TEST_PUBKEY);
    case.release("0.1.1", VALID_SIG, TAMPERED);
    case.assert_rejected_and_untouched();
}

#[test]
fn truncated_and_garbage_signatures_are_rejected() {
    for signature in [TRUNCATED_SIG, GARBAGE_SIG, ""] {
        let case = Case::new(true, TEST_PUBKEY);
        case.release("0.1.1", signature, PAYLOAD);
        case.assert_rejected_and_untouched();
    }
}

#[test]
fn signature_from_the_test_key_does_not_verify_against_the_shipped_key() {
    let case = Case::new(true, &shipped_pubkey());
    case.release("0.1.1", VALID_SIG, PAYLOAD);
    case.assert_rejected_and_untouched();
}

#[test]
fn announced_version_must_match_the_signed_version() {
    let case = Case::new(true, TEST_PUBKEY);
    case.release("0.1.2", VALID_SIG, PAYLOAD);
    case.assert_rejected_and_untouched();
}

#[test]
fn unversioned_signature_is_rejected_when_version_binding_is_required() {
    let strict = Case::new(true, TEST_PUBKEY);
    strict.release("0.1.1", UNVERSIONED_SIG, PAYLOAD);
    strict.assert_rejected_and_untouched();

    let lax = Case::new(false, TEST_PUBKEY);
    lax.release("0.1.2", UNVERSIONED_SIG, PAYLOAD);
    lax.install()
        .expect("an unversioned signature passes without the flag; this is why the flag is on");
}

#[test]
fn corrupt_manifest_and_missing_artifact_fail_cleanly() {
    let case = Case::new(true, TEST_PUBKEY);
    case.server
        .put("/latest.json", b"{\"version\":\"0.1.1\",\"plat".to_vec());
    assert!(case.check().is_err());

    case.release("0.1.1", VALID_SIG, PAYLOAD);
    case.server.routes.lock().unwrap().remove("/Neyra.AppImage");
    case.assert_rejected_and_untouched();

    let empty = Case::new(true, TEST_PUBKEY);
    assert!(empty.check().is_err());
}

#[test]
fn non_elf_payload_with_valid_signature_is_not_installed() {
    // A correctly signed file that is not an AppImage must still be refused.
    let case = Case::new(true, TEST_PUBKEY);
    case.release("0.1.1", VALID_SIG, PAYLOAD);
    let mut not_elf = PAYLOAD.to_vec();
    not_elf[0] = b'X';
    case.server.put("/Neyra.AppImage", not_elf);
    case.assert_rejected_and_untouched();
}

fn shipped_pubkey() -> String {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    config["plugins"]["updater"]["pubkey"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Run by hand against a real signed build, for example:
/// NEYRA_REAL_APPIMAGE=/path/Neyra_0.1.0_amd64.AppImage cargo test --test updater_chain -- --ignored
/// The artifact must be signed with the committed TEST key (see docs/UPDATER.md).
#[test]
#[ignore = "needs NEYRA_REAL_APPIMAGE; see docs/UPDATER.md"]
fn real_signed_appimage_installs_and_tampering_is_rejected() {
    let path = std::env::var("NEYRA_REAL_APPIMAGE").expect("set NEYRA_REAL_APPIMAGE");
    let artifact = std::fs::read(&path).unwrap();
    let signature = std::fs::read_to_string(format!("{path}.sig")).unwrap();
    let version = std::env::var("NEYRA_REAL_VERSION").unwrap_or_else(|_| "0.1.0".into());

    let case = Case::at_version("0.0.9", true, TEST_PUBKEY);
    case.release(&version, &signature, &artifact);
    case.install().unwrap();
    assert_eq!(case.installed(), artifact);

    let mut tampered = artifact.clone();
    let middle = tampered.len() / 2;
    tampered[middle] ^= 0xff;
    let rejected = Case::at_version("0.0.9", true, TEST_PUBKEY);
    rejected.release(&version, &signature, &tampered);
    rejected.assert_rejected_and_untouched();
}
