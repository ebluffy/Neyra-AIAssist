// Adapted from vercel-labs/agent-desktop (Apache-2.0), commit
// 9eb9b296192fcb70bda25e918cd6dd66abfa3d0d. Modified for Neyra's host bridge:
// bounded foreground-window snapshots, session refs and explicit cancellation.
// See NOTICE, THIRD_PARTY.md and third_party/agent-desktop/LICENSE.

use super::{Context, Error, Key, Node, Snapshot};
use std::collections::HashMap;
use windows::{
    core::{Interface, BSTR},
    Win32::{
        Foundation::{GetLastError, SetLastError, ERROR_SUCCESS, HWND, LPARAM, WPARAM},
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        },
        UI::{
            Accessibility::{
                CUIAutomation8, IUIAutomation2, IUIAutomationElement, IUIAutomationInvokePattern,
                IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern,
                IUIAutomationTreeWalker, IUIAutomationValuePattern, UIA_InvokePatternId,
                UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
                UIA_PATTERN_ID,
            },
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
                KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VIRTUAL_KEY,
            },
            WindowsAndMessaging::{
                GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SendMessageTimeoutW,
                SMTO_ABORTIFHUNG, WM_NULL,
            },
        },
    },
};

const MAX_NODES: usize = 512;
const MAX_DEPTH: usize = 24;
const MAX_NAME: usize = 256;

struct Apartment;

impl Apartment {
    fn new() -> Result<Self, Error> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(native_error)?;
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct Entry {
    element: IUIAutomationElement,
    process: i32,
}

struct Session {
    id: String,
    window: HWND,
    process: u32,
    root: IUIAutomationElement,
    focused: IUIAutomationElement,
}

pub(super) struct Backend {
    refs: HashMap<String, Entry>,
    session: Option<Session>,
    walker: IUIAutomationTreeWalker,
    client: IUIAutomation2,
    // Fields drop in declaration order: release all COM interfaces first.
    _apartment: Apartment,
}

impl Backend {
    pub(super) fn new() -> Result<Self, Error> {
        let apartment = Apartment::new()?;
        let client: IUIAutomation2 =
            unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
                .map_err(native_error)?;
        unsafe {
            client.SetConnectionTimeout(2_000).map_err(native_error)?;
            client.SetTransactionTimeout(2_000).map_err(native_error)?;
            // Ref actions address a native element; they must not activate another window.
            client.SetAutoSetFocus(false).map_err(native_error)?;
        }
        let walker = unsafe { client.ControlViewWalker() }.map_err(native_error)?;
        Ok(Self {
            refs: HashMap::new(),
            session: None,
            walker,
            client,
            _apartment: apartment,
        })
    }

    pub(super) fn reset(&mut self) {
        self.refs.clear();
        self.session = None;
    }

    fn begin(&self, ctx: &Context) -> Result<(), Error> {
        ctx.check()?;
        let timeout = ctx.remaining().as_millis().clamp(1, 2_000) as u32;
        unsafe {
            self.client
                .SetConnectionTimeout(timeout)
                .map_err(native_error)?;
            self.client
                .SetTransactionTimeout(timeout)
                .map_err(native_error)?;
        }
        ctx.check()
    }

    pub(super) fn snapshot(&mut self, ctx: &Context, snapshot_id: &str) -> Result<Snapshot, Error> {
        self.reset();
        self.begin(ctx)?;
        let window = unsafe { GetForegroundWindow() };
        if window.0.is_null() {
            return Err(Error::NotFound);
        }
        let process = process_of(window)?;
        probe(window, ctx)?;
        let root = checked(ctx, || unsafe { self.client.ElementFromHandle(window) })?;
        let focused = checked(ctx, || unsafe { self.client.GetFocusedElement() })?;
        let mut refs = HashMap::new();
        let mut truncated = false;
        let tree = self.walk(&root, snapshot_id, 0, &mut refs, &mut truncated, ctx)?;
        let session = Session {
            id: snapshot_id.into(),
            window,
            process,
            root,
            focused,
        };
        self.check_window(&session, ctx)?;
        self.refs = refs;
        self.session = Some(session);
        Ok(Snapshot {
            snapshot_id: snapshot_id.into(),
            tree,
            truncated,
        })
    }

    fn walk(
        &self,
        element: &IUIAutomationElement,
        snapshot_id: &str,
        depth: usize,
        refs: &mut HashMap<String, Entry>,
        truncated: &mut bool,
        ctx: &Context,
    ) -> Result<Node, Error> {
        ctx.check()?;
        let password = checked(ctx, || unsafe { element.CurrentIsPassword() })?.as_bool();
        let control_type = checked(ctx, || unsafe { element.CurrentControlType() })?.0;
        let enabled = checked(ctx, || unsafe { element.CurrentIsEnabled() })?.as_bool();
        let process = checked(ctx, || unsafe { element.CurrentProcessId() })?;
        let name = if password {
            String::new()
        } else {
            checked(ctx, || unsafe { element.CurrentName() })?
                .to_string()
                .chars()
                .take(MAX_NAME)
                .collect()
        };
        let reference = format!("{snapshot_id}:{}", refs.len());
        refs.insert(
            reference.clone(),
            Entry {
                element: element.clone(),
                process,
            },
        );
        let mut children = Vec::new();
        if !password {
            let mut child =
                optional_element(ctx, || unsafe { self.walker.GetFirstChildElement(element) })?;
            while let Some(current) = child {
                if refs.len() >= MAX_NODES || depth >= MAX_DEPTH {
                    *truncated = true;
                    break;
                }
                children.push(self.walk(&current, snapshot_id, depth + 1, refs, truncated, ctx)?);
                child = optional_element(ctx, || unsafe {
                    self.walker.GetNextSiblingElement(&current)
                })?;
            }
        }
        Ok(Node {
            reference,
            role: if password {
                "password".into()
            } else {
                role(control_type).into()
            },
            name,
            enabled,
            children,
        })
    }

    fn check_window(&self, session: &Session, ctx: &Context) -> Result<(), Error> {
        ctx.check()?;
        if unsafe { GetForegroundWindow() } != session.window
            || !unsafe { IsWindow(Some(session.window)) }.as_bool()
            || process_of(session.window)? != session.process
        {
            return Err(Error::StaleRef);
        }
        let current = checked(ctx, || unsafe {
            self.client.ElementFromHandle(session.window)
        })?;
        if !checked(ctx, || unsafe {
            self.client.CompareElements(&current, &session.root)
        })?
        .as_bool()
        {
            return Err(Error::StaleRef);
        }
        Ok(())
    }

    fn check_focus(&self, session: &Session, ctx: &Context) -> Result<(), Error> {
        let focused = checked(ctx, || unsafe { self.client.GetFocusedElement() })
            .map_err(|_| Error::StaleRef)?;
        if !checked(ctx, || unsafe { self.client.CompareElements(&focused, &session.focused) })
            .map_err(|_| Error::StaleRef)?
            .as_bool()
        {
            return Err(Error::StaleRef);
        }
        if checked(ctx, || unsafe { focused.CurrentIsPassword() })
            .map_err(|_| Error::StaleRef)?
            .as_bool()
        {
            return Err(Error::PermissionDenied);
        }
        Ok(())
    }

    fn resolve(&self, reference: &str, ctx: &Context) -> Result<IUIAutomationElement, Error> {
        self.begin(ctx)?;
        let session = self.session.as_ref().ok_or(Error::StaleRef)?;
        if reference.split_once(':').map(|(id, _)| id) != Some(session.id.as_str()) {
            return Err(Error::StaleRef);
        }
        self.check_window(session, ctx)?;
        let entry = self.refs.get(reference).ok_or(Error::NotFound)?;
        if checked(ctx, || unsafe { entry.element.CurrentProcessId() })? != entry.process {
            return Err(Error::StaleRef);
        }
        if checked(ctx, || unsafe { entry.element.CurrentIsPassword() })?.as_bool() {
            return Err(Error::PermissionDenied);
        }
        if !checked(ctx, || unsafe { entry.element.CurrentIsEnabled() })?.as_bool()
            || checked(ctx, || unsafe { entry.element.CurrentIsOffscreen() })?.as_bool()
        {
            return Err(Error::ActionFailed);
        }
        let mut ancestor = Some(entry.element.clone());
        for _ in 0..=MAX_DEPTH + 1 {
            let Some(current) = ancestor else {
                return Err(Error::StaleRef);
            };
            if checked(ctx, || unsafe {
                self.client.CompareElements(&current, &session.root)
            })?
            .as_bool()
            {
                return Ok(entry.element.clone());
            }
            ancestor = optional_element(ctx, || unsafe { self.walker.GetParentElement(&current) })?;
        }
        Err(Error::StaleRef)
    }

    pub(super) fn click(&mut self, reference: &str, ctx: &Context) -> Result<(), Error> {
        let element = self.resolve(reference, ctx)?;
        if let Some(pattern) =
            pattern::<IUIAutomationInvokePattern>(&element, UIA_InvokePatternId, ctx)?
        {
            self.ensure_foreground(ctx)?;
            return checked(ctx, || unsafe { pattern.Invoke() });
        }
        if let Some(pattern) =
            pattern::<IUIAutomationTogglePattern>(&element, UIA_TogglePatternId, ctx)?
        {
            self.ensure_foreground(ctx)?;
            return checked(ctx, || unsafe { pattern.Toggle() });
        }
        if let Some(pattern) =
            pattern::<IUIAutomationSelectionItemPattern>(&element, UIA_SelectionItemPatternId, ctx)?
        {
            self.ensure_foreground(ctx)?;
            return checked(ctx, || unsafe { pattern.Select() });
        }
        Err(Error::ActionFailed)
    }

    pub(super) fn type_text(
        &mut self,
        reference: &str,
        text: &str,
        ctx: &Context,
    ) -> Result<(), Error> {
        let element = self.resolve(reference, ctx)?;
        let value = pattern::<IUIAutomationValuePattern>(&element, UIA_ValuePatternId, ctx)?
            .ok_or(Error::ActionFailed)?;
        if checked(ctx, || unsafe { value.CurrentIsReadOnly() })?.as_bool() {
            return Err(Error::PermissionDenied);
        }
        let text = BSTR::from(text);
        self.ensure_foreground(ctx)?;
        checked(ctx, || unsafe { value.SetValue(&text) })
    }

    fn ensure_foreground(&self, ctx: &Context) -> Result<(), Error> {
        self.begin(ctx)?;
        let session = self.session.as_ref().ok_or(Error::StaleRef)?;
        if unsafe { GetForegroundWindow() } != session.window
            || process_of(session.window)? != session.process
        {
            return Err(Error::StaleRef);
        }
        ctx.check()
    }

    pub(super) fn press(&mut self, keys: &[Key], ctx: &Context) -> Result<(), Error> {
        self.begin(ctx)?;
        self.check_window(self.session.as_ref().ok_or(Error::StaleRef)?, ctx)?;
        let keys: Vec<_> = keys.iter().map(virtual_key).collect();
        // SendInput merges with physical keyboard state. Refuse held keys so
        // cleanup never releases a key that belongs to the user.
        if keys.iter().any(|(key, _)| key_is_down(*key))
            || [0x10, 0x11, 0x12, 0x5b, 0x5c].into_iter().any(key_is_down)
        {
            return Err(Error::ActionFailedNotDelivered);
        }
        let mut events: Vec<_> = keys
            .iter()
            .map(|(key, extended)| key_event(*key, *extended, false))
            .collect();
        let releases: Vec<_> = keys
            .iter()
            .rev()
            .map(|(key, extended)| key_event(*key, *extended, true))
            .collect();
        events.extend_from_slice(&releases);
        self.ensure_foreground(ctx)?;
        self.check_focus(self.session.as_ref().ok_or(Error::StaleRef)?, ctx)?;
        let accepted = unsafe { SendInput(&events, std::mem::size_of::<INPUT>() as i32) };
        if accepted != events.len() as u32 {
            // An accepted prefix can contain key-down events even on failure.
            // Release every requested key; each was confirmed up beforehand.
            if accepted != 0 {
                unsafe { SendInput(&releases, std::mem::size_of::<INPUT>() as i32) };
            }
            return Err(if accepted == 0 {
                Error::PermissionDenied
            } else {
                Error::ActionFailed
            });
        }
        ctx.check()
    }
}

fn checked<T>(ctx: &Context, call: impl FnOnce() -> windows::core::Result<T>) -> Result<T, Error> {
    ctx.check()?;
    let result = call().map_err(native_error)?;
    ctx.check()?;
    Ok(result)
}

fn optional_element(
    ctx: &Context,
    call: impl FnOnce() -> windows::core::Result<IUIAutomationElement>,
) -> Result<Option<IUIAutomationElement>, Error> {
    ctx.check()?;
    let result = match call() {
        Ok(element) => Ok(Some(element)),
        // UIA signals the end of a child/sibling list with a null COM output.
        Err(error) if error.code().0 == 0 => Ok(None),
        Err(error) => Err(native_error(error)),
    };
    ctx.check()?;
    result
}

fn pattern<T: Interface>(
    element: &IUIAutomationElement,
    id: UIA_PATTERN_ID,
    ctx: &Context,
) -> Result<Option<T>, Error> {
    ctx.check()?;
    let result = match unsafe { element.GetCurrentPatternAs::<T>(id) } {
        Ok(pattern) => Ok(Some(pattern)),
        Err(error) if matches!(error.code().0 as u32, 0 | 0x8000_4002 | 0x8004_0204) => Ok(None),
        Err(error) => Err(native_error(error)),
    };
    ctx.check()?;
    result
}

fn process_of(window: HWND) -> Result<u32, Error> {
    let mut process = 0;
    if unsafe { GetWindowThreadProcessId(window, Some(&mut process)) } == 0 || process == 0 {
        Err(Error::StaleRef)
    } else {
        Ok(process)
    }
}

fn probe(window: HWND, ctx: &Context) -> Result<(), Error> {
    ctx.check()?;
    let timeout = ctx.remaining().as_millis().clamp(1, 500) as u32;
    unsafe { SetLastError(ERROR_SUCCESS) };
    if unsafe {
        SendMessageTimeoutW(
            window,
            WM_NULL,
            WPARAM(0),
            LPARAM(0),
            SMTO_ABORTIFHUNG,
            timeout,
            None,
        )
    }
    .0 == 0
    {
        return Err(if unsafe { GetLastError() }.0 == 5 {
            Error::PermissionDenied
        } else {
            Error::Timeout
        });
    }
    ctx.check()
}

fn native_error(error: windows::core::Error) -> Error {
    Error::from_windows_hresult(error.code().0)
}

fn key_is_down(key: u16) -> bool {
    (unsafe { GetAsyncKeyState(i32::from(key)) } as u16 & 0x8000) != 0
}

fn key_event(key: u16, extended: bool, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(key),
                dwFlags: KEYBD_EVENT_FLAGS(
                    if extended { KEYEVENTF_EXTENDEDKEY.0 } else { 0 }
                        | if up { KEYEVENTF_KEYUP.0 } else { 0 },
                ),
                ..Default::default()
            },
        },
    }
}

fn virtual_key(key: &Key) -> (u16, bool) {
    match key {
        Key::Ctrl => (0x11, false),
        Key::Alt => (0x12, false),
        Key::Shift => (0x10, false),
        Key::Meta => (0x5b, true),
        Key::Enter => (0x0d, false),
        Key::Tab => (0x09, false),
        Key::Escape => (0x1b, false),
        Key::Backspace => (0x08, false),
        Key::Delete => (0x2e, true),
        Key::Space => (0x20, false),
        Key::Up => (0x26, true),
        Key::Down => (0x28, true),
        Key::Left => (0x25, true),
        Key::Right => (0x27, true),
        Key::Home => (0x24, true),
        Key::End => (0x23, true),
        Key::PageUp => (0x21, true),
        Key::PageDown => (0x22, true),
        Key::Letter(letter) => (u16::from(letter.to_ascii_uppercase()), false),
        Key::Digit(digit) => (u16::from(*digit), false),
        Key::Function(number) => (0x6f + u16::from(*number), false),
    }
}

fn role(control: i32) -> &'static str {
    match control {
        50000 | 50031 => "button",
        50002 => "checkbox",
        50003 => "combobox",
        50004 => "textbox",
        50005 => "link",
        50006 => "image",
        50007 => "listitem",
        50008 => "list",
        50009 => "menu",
        50010 => "menubar",
        50011 => "menuitem",
        50012 => "progressbar",
        50013 => "radio",
        50014 => "scrollbar",
        50015 => "slider",
        50016 => "spinbutton",
        50017 => "status",
        50018 => "tablist",
        50019 => "tab",
        50020 => "text",
        50021 => "toolbar",
        50022 => "tooltip",
        50023 => "tree",
        50024 => "treeitem",
        50026 | 50033 => "group",
        50028 => "grid",
        50029 => "cell",
        50030 => "document",
        50032 => "window",
        50034 => "columnheader",
        50035 => "rowheader",
        50036 => "table",
        50038 => "separator",
        _ => "element",
    }
}
