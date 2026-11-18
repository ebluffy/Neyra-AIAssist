# Third-party notices

## agent-desktop

- Project: [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop).
- Revision: [`9eb9b296192fcb70bda25e918cd6dd66abfa3d0d`](https://github.com/vercel-labs/agent-desktop/tree/9eb9b296192fcb70bda25e918cd6dd66abfa3d0d).
- License: [Apache-2.0](third_party/agent-desktop/LICENSE).
- Attribution: the agent-desktop project and its contributors. The referenced revision contains no separate upstream NOTICE file.
- Adaptation: `client/src-tauri/src/computer/mod.rs`, `windows.rs` and `macos.rs`, based on `crates/core`, `crates/windows` and `crates/macos`.

Neyra uses a reduced accessibility snapshot and element-reference implementation for Windows UI Automation and macOS Accessibility. The adaptation limits traversal to the foreground window, omits text values, scopes references to one snapshot, and routes mutations through the existing host policy and confirmation flow. Cancellation, reference expiry and invalidation, and stable errors are implemented for the Neyra host bridge. No agent-desktop process, CLI, or Linux backend is distributed with this implementation.

The upstream source is available at the pinned revision above; the original Apache-2.0 license is reproduced without changes. These notices apply to this adaptation and do not replace the repository's own license.
