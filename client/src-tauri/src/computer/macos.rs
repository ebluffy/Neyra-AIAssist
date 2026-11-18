// Adapted from agent-desktop's AX ownership, bounded IPC and keyboard approach.
// Upstream revision and Apache-2.0 attribution are recorded in THIRD_PARTY.md.
use super::{Context, Error, Key, Node, Snapshot};
use std::{collections::HashMap, ffi::c_void, ptr, time::Duration};

type CFRef = *const c_void;
const MAX_NODES: usize = 512;
const MAX_DEPTH: usize = 12;
const MAX_LABEL_UTF16: usize = 256;
const AX_UNSUPPORTED: i32 = -25205;
const AX_NO_VALUE: i32 = -25212;

#[repr(C)]
struct CFRange {
    location: isize,
    length: isize,
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRetain(value: CFRef) -> CFRef;
    fn CFRelease(value: CFRef);
    fn CFEqual(a: CFRef, b: CFRef) -> u8;
    fn CFGetTypeID(value: CFRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFStringCreateWithCharacters(allocator: CFRef, chars: *const u16, count: isize) -> CFRef;
    fn CFStringGetLength(value: CFRef) -> isize;
    fn CFStringGetCharacters(value: CFRef, range: CFRange, buffer: *mut u16);
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(value: CFRef) -> u8;
    fn CFArrayGetTypeID() -> usize;
    fn CFArrayGetCount(array: CFRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFRef, index: isize) -> CFRef;
    fn CFDictionaryGetTypeID() -> usize;
    fn CFDictionaryGetValue(dictionary: CFRef, key: CFRef) -> CFRef;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberGetValue(number: CFRef, kind: isize, value: *mut c_void) -> u8;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementGetTypeID() -> usize;
    fn AXUIElementCreateSystemWide() -> CFRef;
    fn AXUIElementSetMessagingTimeout(element: CFRef, seconds: f32) -> i32;
    fn AXUIElementCopyAttributeValue(element: CFRef, attribute: CFRef, result: *mut CFRef) -> i32;
    fn AXUIElementGetAttributeValueCount(
        element: CFRef,
        attribute: CFRef,
        count: *mut isize,
    ) -> i32;
    fn AXUIElementCopyAttributeValues(
        element: CFRef,
        attribute: CFRef,
        index: isize,
        maximum: isize,
        result: *mut CFRef,
    ) -> i32;
    fn AXUIElementGetPid(element: CFRef, pid: *mut i32) -> i32;
    fn AXUIElementPerformAction(element: CFRef, action: CFRef) -> i32;
    fn AXUIElementIsAttributeSettable(element: CFRef, attribute: CFRef, settable: *mut u8) -> i32;
    fn AXUIElementSetAttributeValue(element: CFRef, attribute: CFRef, value: CFRef) -> i32;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGSessionCopyCurrentDictionary() -> CFRef;
    fn CGEventCreateKeyboardEvent(source: CFRef, keycode: u16, down: bool) -> CFRef;
    fn CGEventSetFlags(event: CFRef, flags: u64);
    fn CGEventPostToPid(pid: i32, event: CFRef);
}

struct Owned(CFRef);

impl Owned {
    fn new(value: CFRef) -> Result<Self, Error> {
        if value.is_null() {
            Err(Error::ActionFailed)
        } else {
            Ok(Self(value))
        }
    }

    fn string(value: &str) -> Result<Self, Error> {
        let utf16: Vec<_> = value.encode_utf16().collect();
        Self::new(unsafe {
            CFStringCreateWithCharacters(ptr::null(), utf16.as_ptr(), utf16.len() as isize)
        })
    }

    fn is_element(&self) -> bool {
        unsafe { CFGetTypeID(self.0) == AXUIElementGetTypeID() }
    }

    fn same(&self, other: &Self) -> bool {
        unsafe { CFEqual(self.0, other.0) != 0 }
    }
}

impl Clone for Owned {
    fn clone(&self) -> Self {
        Self(unsafe { CFRetain(self.0) })
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}

fn ax_result(code: i32) -> Result<(), Error> {
    if code == 0 {
        Ok(())
    } else {
        Err(Error::from_ax_error(code))
    }
}

fn prepare(element: &Owned, ctx: &Context, mutation: bool) -> Result<(), Error> {
    ctx.check()?;
    let remaining = ctx.remaining();
    let slice = if mutation {
        (remaining / 2)
            .max(Duration::from_millis(250))
            .min(remaining)
    } else {
        remaining.min(Duration::from_millis(250))
    };
    if slice.is_zero() {
        return Err(Error::Timeout);
    }
    ax_result(unsafe { AXUIElementSetMessagingTimeout(element.0, slice.as_secs_f32()) })
}

fn attribute(element: &Owned, name: &str, ctx: &Context) -> Result<Option<Owned>, Error> {
    let name = Owned::string(name)?;
    prepare(element, ctx, false)?;
    let mut value = ptr::null();
    let code = unsafe { AXUIElementCopyAttributeValue(element.0, name.0, &mut value) };
    // A failed native call may still return a retained value.
    let value = if value.is_null() {
        None
    } else {
        Some(Owned(value))
    };
    ctx.check()?;
    if matches!(code, AX_UNSUPPORTED | AX_NO_VALUE) {
        return Ok(None);
    }
    ax_result(code)?;
    value.map(Some).ok_or(Error::ActionFailed)
}

fn element_attribute(element: &Owned, name: &str, ctx: &Context) -> Result<Option<Owned>, Error> {
    let value = attribute(element, name, ctx)?;
    if value.as_ref().is_some_and(|v| !v.is_element()) {
        return Err(Error::ActionFailed);
    }
    Ok(value)
}

fn label(element: &Owned, name: &str, ctx: &Context) -> Result<String, Error> {
    let Some(value) = attribute(element, name, ctx)? else {
        return Ok(String::new());
    };
    if unsafe { CFGetTypeID(value.0) != CFStringGetTypeID() } {
        return Err(Error::ActionFailed);
    }
    let count = unsafe { CFStringGetLength(value.0) }.clamp(0, MAX_LABEL_UTF16 as isize);
    let mut units = vec![0; count as usize];
    unsafe {
        CFStringGetCharacters(
            value.0,
            CFRange {
                location: 0,
                length: count,
            },
            units.as_mut_ptr(),
        )
    };
    Ok(String::from_utf16_lossy(&units))
}

fn boolean(element: &Owned, name: &str, ctx: &Context) -> Result<Option<bool>, Error> {
    attribute(element, name, ctx)?
        .map(|v| cf_boolean(v.0).ok_or(Error::ActionFailed))
        .transpose()
}

fn cf_boolean(value: CFRef) -> Option<bool> {
    if value.is_null() || unsafe { CFGetTypeID(value) != CFBooleanGetTypeID() } {
        None
    } else {
        Some(unsafe { CFBooleanGetValue(value) != 0 })
    }
}

fn protected(element: &Owned, role: &str, ctx: &Context) -> Result<bool, Error> {
    Ok(role == "AXSecureTextField"
        || label(element, "AXSubrole", ctx)? == "AXSecureTextField"
        || boolean(element, "AXProtectedContent", ctx)?.unwrap_or(false))
}

struct Target {
    element: Owned,
    protected: bool,
}

pub(super) struct Backend {
    system: Owned,
    app: Option<Owned>,
    window: Option<Owned>,
    focused: Option<Owned>,
    pid: i32,
    snapshot_id: String,
    targets: HashMap<String, Target>,
    truncated: bool,
}

impl Backend {
    pub(super) fn new() -> Result<Self, Error> {
        Ok(Self {
            system: Owned::new(unsafe { AXUIElementCreateSystemWide() })?,
            app: None,
            window: None,
            focused: None,
            pid: 0,
            snapshot_id: String::new(),
            targets: HashMap::new(),
            truncated: false,
        })
    }

    pub(super) fn reset(&mut self) {
        self.targets.clear();
        self.app = None;
        self.window = None;
        self.focused = None;
        self.pid = 0;
        self.snapshot_id.clear();
        self.truncated = false;
    }

    fn foreground(&self, ctx: &Context) -> Result<(Owned, Owned, i32), Error> {
        ctx.check()?;
        if !session_unlocked() || !unsafe { AXIsProcessTrusted() } {
            return Err(Error::PermissionDenied);
        }
        let app =
            element_attribute(&self.system, "AXFocusedApplication", ctx)?.ok_or(Error::NotFound)?;
        let window = element_attribute(&app, "AXFocusedWindow", ctx)?.ok_or(Error::NotFound)?;
        prepare(&app, ctx, false)?;
        let mut pid = 0;
        ax_result(unsafe { AXUIElementGetPid(app.0, &mut pid) })?;
        if pid <= 0 {
            return Err(Error::NotFound);
        }
        ctx.check()?;
        Ok((app, window, pid))
    }

    fn verify_foreground(&self, ctx: &Context) -> Result<(), Error> {
        if self.snapshot_id.is_empty() {
            return Err(Error::StaleRef);
        }
        let (app, window, pid) = self.foreground(ctx)?;
        if pid != self.pid
            || self.app.as_ref().is_none_or(|v| !v.same(&app))
            || self.window.as_ref().is_none_or(|v| !v.same(&window))
        {
            return Err(Error::StaleRef);
        }
        Ok(())
    }

    pub(super) fn snapshot(&mut self, ctx: &Context, snapshot_id: &str) -> Result<Snapshot, Error> {
        self.reset();
        let result = (|| {
            let (app, window, pid) = self.foreground(ctx)?;
            self.focused = element_attribute(&app, "AXFocusedUIElement", ctx)?;
            self.app = Some(app);
            self.window = Some(window.clone());
            self.pid = pid;
            self.snapshot_id = snapshot_id.to_owned();
            let tree = self.walk(window, 0, ctx)?;
            self.verify_foreground(ctx)?;
            Ok(Snapshot {
                snapshot_id: snapshot_id.to_owned(),
                tree,
                truncated: self.truncated,
            })
        })();
        if result.is_err() {
            self.reset();
        }
        result
    }

    fn walk(&mut self, element: Owned, depth: usize, ctx: &Context) -> Result<Node, Error> {
        ctx.check()?;
        let role = label(&element, "AXRole", ctx)?;
        let protected = protected(&element, &role, ctx)?;
        let name = if protected {
            String::new()
        } else {
            let title = label(&element, "AXTitle", ctx)?;
            if title.is_empty() {
                label(&element, "AXDescription", ctx)?
            } else {
                title
            }
        };
        let enabled = !protected && boolean(&element, "AXEnabled", ctx)?.unwrap_or(true);
        let reference = format!("{}:{}", self.snapshot_id, self.targets.len());
        self.targets.insert(
            reference.clone(),
            Target {
                element: element.clone(),
                protected,
            },
        );
        let mut children = Vec::new();
        if !protected {
            if depth >= MAX_DEPTH || self.targets.len() >= MAX_NODES {
                self.truncated = true;
            } else {
                let child_name = Owned::string("AXChildren")?;
                prepare(&element, ctx, false)?;
                let mut count = 0;
                let code = unsafe {
                    AXUIElementGetAttributeValueCount(element.0, child_name.0, &mut count)
                };
                if !matches!(code, AX_UNSUPPORTED | AX_NO_VALUE) {
                    ax_result(code)?;
                    let count = count.max(0) as usize;
                    let limit = count.min(MAX_NODES - self.targets.len());
                    self.truncated |= limit < count;
                    if limit > 0 {
                        prepare(&element, ctx, false)?;
                        let mut array = ptr::null();
                        let code = unsafe {
                            AXUIElementCopyAttributeValues(
                                element.0,
                                child_name.0,
                                0,
                                limit as isize,
                                &mut array,
                            )
                        };
                        let array = if array.is_null() {
                            None
                        } else {
                            Some(Owned(array))
                        };
                        ax_result(code)?;
                        let array = array.ok_or(Error::ActionFailed)?;
                        if unsafe { CFGetTypeID(array.0) != CFArrayGetTypeID() } {
                            return Err(Error::ActionFailed);
                        }
                        let actual = unsafe { CFArrayGetCount(array.0) }.max(0) as usize;
                        self.truncated |= actual < count;
                        for index in 0..actual.min(limit) {
                            ctx.check()?;
                            if self.targets.len() >= MAX_NODES {
                                self.truncated = true;
                                break;
                            }
                            let raw = unsafe { CFArrayGetValueAtIndex(array.0, index as isize) };
                            if raw.is_null()
                                || unsafe { CFGetTypeID(raw) != AXUIElementGetTypeID() }
                            {
                                return Err(Error::ActionFailed);
                            }
                            let child = Owned(unsafe { CFRetain(raw) });
                            if self.targets.values().any(|v| v.element.same(&child)) {
                                self.truncated = true;
                                continue;
                            }
                            children.push(self.walk(child, depth + 1, ctx)?);
                        }
                    }
                }
            }
        }
        Ok(Node {
            reference,
            role,
            name,
            enabled,
            children,
        })
    }

    fn target(&self, reference: &str, ctx: &Context) -> Result<Owned, Error> {
        self.verify_foreground(ctx)?;
        if reference.split_once(':').map(|(id, _)| id) != Some(self.snapshot_id.as_str()) {
            return Err(Error::StaleRef);
        }
        let target = self.targets.get(reference).ok_or(Error::NotFound)?;
        let role = label(&target.element, "AXRole", ctx)?;
        if target.protected || protected(&target.element, &role, ctx)? {
            return Err(Error::PermissionDenied);
        }
        if boolean(&target.element, "AXEnabled", ctx)? == Some(false) {
            return Err(Error::ActionFailed);
        }
        let window = self.window.as_ref().ok_or(Error::StaleRef)?;
        if !target.element.same(window) {
            let current =
                element_attribute(&target.element, "AXWindow", ctx)?.ok_or(Error::StaleRef)?;
            if !current.same(window) {
                return Err(Error::StaleRef);
            }
        }
        Ok(target.element.clone())
    }

    pub(super) fn click(&mut self, reference: &str, ctx: &Context) -> Result<(), Error> {
        let target = self.target(reference, ctx)?;
        let action = Owned::string("AXPress")?;
        self.verify_foreground(ctx)?;
        prepare(&target, ctx, true)?;
        ctx.check()?;
        ax_result(unsafe { AXUIElementPerformAction(target.0, action.0) })
    }

    pub(super) fn type_text(
        &mut self,
        reference: &str,
        text: &str,
        ctx: &Context,
    ) -> Result<(), Error> {
        let target = self.target(reference, ctx)?;
        let attribute = Owned::string("AXValue")?;
        prepare(&target, ctx, false)?;
        let mut settable = 0;
        ax_result(unsafe { AXUIElementIsAttributeSettable(target.0, attribute.0, &mut settable) })?;
        if settable == 0 {
            return Err(Error::ActionFailed);
        }
        let value = Owned::string(text)?;
        self.verify_foreground(ctx)?;
        prepare(&target, ctx, true)?;
        ctx.check()?;
        ax_result(unsafe { AXUIElementSetAttributeValue(target.0, attribute.0, value.0) })
    }

    pub(super) fn press(&mut self, keys: &[Key], ctx: &Context) -> Result<(), Error> {
        self.verify_foreground(ctx)?;
        let app = self.app.as_ref().ok_or(Error::StaleRef)?;
        let focused = element_attribute(app, "AXFocusedUIElement", ctx)?.ok_or(Error::NotFound)?;
        if self.focused.as_ref().is_none_or(|v| !v.same(&focused)) {
            return Err(Error::StaleRef);
        }
        let role = label(&focused, "AXRole", ctx)?;
        if protected(&focused, &role, ctx)? {
            return Err(Error::PermissionDenied);
        }
        let mut flags = 0;
        let mut main_key = None;
        for key in keys {
            match key {
                Key::Shift => flags |= 1 << 17,
                Key::Ctrl => flags |= 1 << 18,
                Key::Alt => flags |= 1 << 19,
                Key::Meta => flags |= 1 << 20,
                key => {
                    if main_key.replace(keycode(key)?).is_some() {
                        return Err(Error::InvalidArguments);
                    }
                }
            }
        }
        let code = main_key.ok_or(Error::InvalidArguments)?;
        let down = Owned::new(unsafe { CGEventCreateKeyboardEvent(ptr::null(), code, true) })?;
        let up = Owned::new(unsafe { CGEventCreateKeyboardEvent(ptr::null(), code, false) })?;
        unsafe {
            CGEventSetFlags(down.0, flags);
            CGEventSetFlags(up.0, flags);
        }
        self.verify_foreground(ctx)?;
        let current = element_attribute(app, "AXFocusedUIElement", ctx)?.ok_or(Error::StaleRef)?;
        if !current.same(&focused) {
            return Err(Error::StaleRef);
        }
        ctx.check()?;
        // Both events are created before dispatch; a sent key is always released.
        unsafe {
            CGEventPostToPid(self.pid, down.0);
            CGEventPostToPid(self.pid, up.0);
        }
        Ok(())
    }
}

fn keycode(key: &Key) -> Result<u16, Error> {
    Ok(match key {
        Key::Letter(value) if value.is_ascii_alphabetic() => {
            const LETTERS: [u16; 26] = [
                0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13,
                7, 16, 6,
            ];
            LETTERS[(value.to_ascii_lowercase() - b'a') as usize]
        }
        Key::Digit(value) if value.is_ascii_digit() => {
            [29, 18, 19, 20, 21, 23, 22, 26, 28, 25][(value - b'0') as usize]
        }
        Key::Function(value) if (1..=12).contains(value) => {
            [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111][(value - 1) as usize]
        }
        Key::Enter => 36,
        Key::Tab => 48,
        Key::Escape => 53,
        Key::Backspace => 51,
        Key::Delete => 117,
        Key::Space => 49,
        Key::Up => 126,
        Key::Down => 125,
        Key::Left => 123,
        Key::Right => 124,
        Key::Home => 115,
        Key::End => 119,
        Key::PageUp => 116,
        Key::PageDown => 121,
        _ => return Err(Error::InvalidArguments),
    })
}

pub(super) fn session_unlocked() -> bool {
    let Ok(dictionary) = Owned::new(unsafe { CGSessionCopyCurrentDictionary() }) else {
        return false;
    };
    if unsafe { CFGetTypeID(dictionary.0) != CFDictionaryGetTypeID() } {
        return false;
    }
    let get = |key: &str| -> Option<CFRef> {
        let key = Owned::string(key).ok()?;
        let value = unsafe { CFDictionaryGetValue(dictionary.0, key.0) };
        (!value.is_null()).then_some(value)
    };
    if get("kCGSSessionOnConsoleKey").and_then(cf_boolean) != Some(true)
        || get("kCGSessionLoginDoneKey").and_then(cf_boolean) != Some(true)
    {
        return false;
    }
    // Quartz omits this key on an unlocked session. A present unexpected type fails closed.
    if get("CGSSessionScreenIsLocked").is_some_and(|value| cf_boolean(value) != Some(false)) {
        return false;
    }
    let Some(uid) = get("kCGSSessionUserIDKey") else {
        return false;
    };
    if unsafe { CFGetTypeID(uid) != CFNumberGetTypeID() } {
        return false;
    }
    let mut owner = -1_i64;
    const CF_NUMBER_SINT64: isize = 4;
    let read =
        unsafe { CFNumberGetValue(uid, CF_NUMBER_SINT64, (&mut owner as *mut i64).cast()) != 0 };
    read && owner > 0 && owner == unsafe { libc::geteuid() } as i64
}
