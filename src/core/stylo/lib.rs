//! Minimal panic-safe C ABI around Stylo.
//!
//! The embedder owns the DOM. This crate stores opaque node handles and asks
//! the embedder for node data through callbacks; it never creates a duplicate
//! Rust DOM. Stylesheet replacement is parsed by Stylo itself and committed as
//! one batch. Traversal/property serialization remain explicit unsupported
//! operations until the full Stylo DOM trait adapter is wired.

use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

use servo_arc::Arc;
use style::context::QuirksMode;
use style::properties::{parse_style_attribute, PropertyId};
use style::shared_lock::SharedRwLock;
use style::stylesheets::{CssRuleType, Origin, Stylesheet, UrlExtraData};

const ABI_VERSION: u32 = 1;

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StyloStatus {
    Ok = 0,
    InvalidArgument = 1,
    NullPointer = 2,
    InvalidUtf8 = 3,
    CallbackMissing = 4,
    CallbackFailed = 5,
    Unsupported = 6,
    Panic = 7,
    BufferTooSmall = 8,
    ParseError = 9,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct StyloSlice {
    pub ptr: *const u8,
    pub len: usize,
}

impl StyloSlice {
    fn as_bytes(self) -> Result<&'static [u8], StyloStatus> {
        if self.len == 0 {
            return Ok(&[]);
        }
        if self.ptr.is_null() {
            return Err(StyloStatus::NullPointer);
        }
        // The caller owns the bytes for the duration of this synchronous ABI
        // call; no slice is retained by the engine.
        Ok(unsafe { std::slice::from_raw_parts(self.ptr, self.len) })
    }

    fn as_str(self) -> Result<&'static str, StyloStatus> {
        std::str::from_utf8(self.as_bytes()?).map_err(|_| StyloStatus::InvalidUtf8)
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct StyloNodeInfo {
    pub node_id: u64,
    pub parent_id: u64,
    pub kind: u32,
    pub flags: u32,
    pub tag_name: StyloSlice,
    pub id: StyloSlice,
    pub classes: StyloSlice,
}

pub type StyloReadNodeCallback = unsafe extern "C" fn(
    ctx: *mut c_void,
    node: *const c_void,
    out: *mut StyloNodeInfo,
) -> StyloStatus;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct StyloDomCallbacks {
    pub ctx: *mut c_void,
    pub read_node: Option<StyloReadNodeCallback>,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StyloStylesheetOrigin {
    UserAgent = 0,
    User = 1,
    Author = 2,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct StyloStylesheetInput {
    pub sheet_id: u64,
    pub origin: StyloStylesheetOrigin,
    pub enabled: u8,
    pub reserved: [u8; 7],
    pub css: StyloSlice,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct StyloFlushResult {
    pub invalidation_generation: u64,
    pub changed_node_count: usize,
}

#[repr(C)]
pub struct StyloEngine {
    inner: Engine,
}

#[allow(dead_code)]
struct ParsedStylesheet {
    sheet_id: u64,
    origin: StyloStylesheetOrigin,
    enabled: bool,
    sheet: Arc<Stylesheet>,
}

struct Engine {
    callbacks: StyloDomCallbacks,
    sheets: Vec<ParsedStylesheet>,
    url_data: UrlExtraData,
    invalidation_generation: u64,
    last_error: String,
}

impl Engine {
    fn new(callbacks: StyloDomCallbacks) -> Self {
        Self {
            callbacks,
            sheets: Vec::new(),
            url_data: UrlExtraData::from(
                url::Url::parse("about:blank")
                    .expect("the static about:blank URL must always be valid"),
            ),
            invalidation_generation: 0,
            last_error: String::new(),
        }
    }

    fn error(&mut self, status: StyloStatus, message: impl Into<String>) -> StyloStatus {
        self.last_error = format!("{status:?}: {}", message.into());
        status
    }

    fn replace_stylesheets(&mut self, inputs: &[StyloStylesheetInput]) -> Result<(), StyloStatus> {
        if inputs.len() > 65_536 {
            return Err(StyloStatus::InvalidArgument);
        }
        let lock = SharedRwLock::new();
        let mut parsed = Vec::with_capacity(inputs.len());

        // Parse the complete batch before publishing it, so replacement is
        // atomic from the embedder's perspective.
        for input in inputs {
            if input.sheet_id == 0 {
                return Err(StyloStatus::InvalidArgument);
            }
            if parsed
                .iter()
                .any(|sheet: &ParsedStylesheet| sheet.sheet_id == input.sheet_id)
            {
                return Err(StyloStatus::InvalidArgument);
            }
            let origin = match input.origin {
                StyloStylesheetOrigin::UserAgent => Origin::UserAgent,
                StyloStylesheetOrigin::User => Origin::User,
                StyloStylesheetOrigin::Author => Origin::Author,
            };
            let sheet = Stylesheet::from_bytes(
                input.css.as_bytes()?,
                self.url_data.clone(),
                None,
                None,
                origin,
                Arc::new(lock.wrap(style::media_queries::MediaList::empty())),
                lock.clone(),
                None,
                None,
                QuirksMode::NoQuirks,
            );
            if input.enabled == 0 {
                sheet.set_disabled(true);
            }
            parsed.push(ParsedStylesheet {
                sheet_id: input.sheet_id,
                origin: input.origin,
                enabled: input.enabled != 0,
                sheet: Arc::new(sheet),
            });
        }
        self.sheets = parsed;
        self.invalidation_generation = self.invalidation_generation.wrapping_add(1);
        Ok(())
    }

    fn sync_node(&mut self, node: *const c_void, out: Option<*mut StyloNodeInfo>) -> StyloStatus {
        if node.is_null() {
            return self.error(StyloStatus::NullPointer, "node is null");
        }
        let callback = match self.callbacks.read_node {
            Some(callback) => callback,
            None => return self.error(StyloStatus::CallbackMissing, "read_node is unset"),
        };
        let mut local_info = StyloNodeInfo::default();
        let info = out.unwrap_or(&mut local_info as *mut StyloNodeInfo);
        let status = unsafe { callback(self.callbacks.ctx, node, info) };
        if status != StyloStatus::Ok {
            return self.error(status, "read_node callback failed");
        }
        if unsafe { (*info).node_id } == 0 {
            return self.error(StyloStatus::InvalidArgument, "callback returned node_id 0");
        }
        self.invalidation_generation = self.invalidation_generation.wrapping_add(1);
        self.last_error.clear();
        StyloStatus::Ok
    }

    fn serialize_specified_property(
        &mut self,
        property: StyloSlice,
        value: StyloSlice,
        out: *mut u8,
        capacity: usize,
        written: *mut usize,
    ) -> StyloStatus {
        let property = match property.as_str() {
            Ok(property) if !property.is_empty() => property,
            Ok(_) => return self.error(StyloStatus::InvalidArgument, "property is empty"),
            Err(status) => return self.error(status, "property is not UTF-8"),
        };
        let value = match value.as_str() {
            Ok(value) => value,
            Err(status) => return self.error(status, "value is not UTF-8"),
        };
        let property_id = match PropertyId::parse_enabled_for_all_content(property) {
            Ok(property_id) => property_id,
            Err(()) => return self.error(StyloStatus::ParseError, "unknown property"),
        };
        let declaration = format!("{property}: {value}");
        let block = parse_style_attribute(
            &declaration,
            &self.url_data,
            None,
            QuirksMode::NoQuirks,
            CssRuleType::Style,
        );
        if block.is_empty() {
            return self.error(StyloStatus::ParseError, "invalid property value");
        }
        let mut serialized = String::new();
        if block
            .property_value_to_css(&property_id, &mut serialized)
            .is_err()
        {
            return self.error(StyloStatus::Panic, "Stylo property serialization failed");
        }
        if serialized.is_empty() {
            return self.error(StyloStatus::ParseError, "property was not retained");
        }
        let status = copy_buffer(serialized.as_bytes(), out, capacity, written);
        if status != StyloStatus::Ok {
            return self.error(status, "property output buffer is too small");
        }
        self.last_error.clear();
        StyloStatus::Ok
    }
}

fn with_engine<T>(
    engine: *mut StyloEngine,
    f: impl FnOnce(&mut Engine) -> T,
) -> Result<T, StyloStatus> {
    if engine.is_null() {
        return Err(StyloStatus::NullPointer);
    }
    catch_unwind(AssertUnwindSafe(|| unsafe { f(&mut (*engine).inner) }))
        .map_err(|_| StyloStatus::Panic)
}

fn copy_buffer(bytes: &[u8], out: *mut u8, capacity: usize, written: *mut usize) -> StyloStatus {
    if written.is_null() {
        return StyloStatus::NullPointer;
    }
    unsafe { *written = bytes.len() };
    if bytes.is_empty() {
        return StyloStatus::Ok;
    }
    if out.is_null() {
        return StyloStatus::NullPointer;
    }
    if capacity < bytes.len() {
        return StyloStatus::BufferTooSmall;
    }
    unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len()) };
    StyloStatus::Ok
}

#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_engine_new(
    callbacks: *const StyloDomCallbacks,
    out_engine: *mut *mut StyloEngine,
) -> StyloStatus {
    catch_unwind(AssertUnwindSafe(|| {
        if callbacks.is_null() || out_engine.is_null() {
            return StyloStatus::NullPointer;
        }
        let callbacks = unsafe { *callbacks };
        let engine = Box::new(StyloEngine {
            inner: Engine::new(callbacks),
        });
        unsafe { *out_engine = Box::into_raw(engine) };
        StyloStatus::Ok
    }))
    .unwrap_or(StyloStatus::Panic)
}

#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_engine_destroy(engine: *mut StyloEngine) -> StyloStatus {
    if engine.is_null() {
        return StyloStatus::NullPointer;
    }
    catch_unwind(AssertUnwindSafe(|| unsafe { drop(Box::from_raw(engine)) }))
        .map(|_| StyloStatus::Ok)
        .unwrap_or(StyloStatus::Panic)
}

#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_engine_replace_stylesheets(
    engine: *mut StyloEngine,
    inputs: *const StyloStylesheetInput,
    count: usize,
) -> StyloStatus {
    match with_engine(engine, |inner| {
        if count != 0 && inputs.is_null() {
            return inner.error(StyloStatus::NullPointer, "inputs is null");
        }
        let inputs = if count == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(inputs, count) }
        };
        match inner.replace_stylesheets(inputs) {
            Ok(()) => {
                inner.last_error.clear();
                StyloStatus::Ok
            }
            Err(status) => inner.error(status, "stylesheet replacement rejected"),
        }
    }) {
        Ok(status) | Err(status) => status,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_engine_sync_node(
    engine: *mut StyloEngine,
    node: *const c_void,
) -> StyloStatus {
    match with_engine(engine, |inner| inner.sync_node(node, None)) {
        Ok(status) | Err(status) => status,
    }
}

/// Read one authoritative node into caller-owned storage without retaining a
/// Rust-side DOM mirror.
#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_engine_sync_node_info(
    engine: *mut StyloEngine,
    node: *const c_void,
    out: *mut StyloNodeInfo,
) -> StyloStatus {
    match with_engine(engine, |inner| {
        if out.is_null() {
            return inner.error(StyloStatus::NullPointer, "out is null");
        }
        inner.sync_node(node, Some(out))
    }) {
        Ok(status) | Err(status) => status,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_engine_invalidation_generation(
    engine: *const StyloEngine,
    out_generation: *mut u64,
) -> StyloStatus {
    catch_unwind(AssertUnwindSafe(|| {
        if engine.is_null() || out_generation.is_null() {
            return StyloStatus::NullPointer;
        }
        unsafe { *out_generation = (*engine).inner.invalidation_generation };
        StyloStatus::Ok
    }))
    .unwrap_or(StyloStatus::Panic)
}

#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_engine_flush_styles(
    engine: *mut StyloEngine,
    nodes: *const u64,
    node_count: usize,
    out_result: *mut StyloFlushResult,
) -> StyloStatus {
    match with_engine(engine, |inner| {
        if node_count != 0 && nodes.is_null() {
            return inner.error(StyloStatus::NullPointer, "nodes is null");
        }
        if out_result.is_null() {
            return inner.error(StyloStatus::NullPointer, "out_result is null");
        }
        unsafe {
            *out_result = StyloFlushResult {
                invalidation_generation: inner.invalidation_generation,
                changed_node_count: 0,
            };
        }
        inner.error(
            StyloStatus::Unsupported,
            "style flush requires Stylo DOM traversal",
        )
    }) {
        Ok(status) | Err(status) => status,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_engine_serialize_property(
    engine: *mut StyloEngine,
    node_id: u64,
    property: StyloSlice,
    out: *mut u8,
    capacity: usize,
    written: *mut usize,
) -> StyloStatus {
    match with_engine(engine, |inner| {
        if node_id == 0 {
            return inner.error(StyloStatus::InvalidArgument, "node_id is zero");
        }
        if property.as_str().is_err() {
            return inner.error(StyloStatus::InvalidUtf8, "property is not UTF-8");
        }
        if written.is_null() {
            return inner.error(StyloStatus::NullPointer, "written is null");
        }
        let _ = (out, capacity);
        unsafe { *written = 0 };
        inner.error(StyloStatus::Unsupported, "computed style is not flushed")
    }) {
        Ok(status) | Err(status) => status,
    }
}

/// Parse and canonicalize one specified property value through Stylo's CSSOM
/// declaration parser. This is intentionally separate from computed-style
/// serialization, which remains unsupported until DOM traversal is wired.
#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_engine_serialize_specified_property(
    engine: *mut StyloEngine,
    property: StyloSlice,
    value: StyloSlice,
    out: *mut u8,
    capacity: usize,
    written: *mut usize,
) -> StyloStatus {
    match with_engine(engine, |inner| {
        inner.serialize_specified_property(property, value, out, capacity, written)
    }) {
        Ok(status) | Err(status) => status,
    }
}

/// Return the number of parsed stylesheet objects retained by the engine.
#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_engine_stylesheet_count(
    engine: *const StyloEngine,
    out_count: *mut usize,
) -> StyloStatus {
    catch_unwind(AssertUnwindSafe(|| {
        if engine.is_null() || out_count.is_null() {
            return StyloStatus::NullPointer;
        }
        unsafe { *out_count = (*engine).inner.sheets.len() };
        StyloStatus::Ok
    }))
    .unwrap_or(StyloStatus::Panic)
}

/// Return the number of top-level Stylo rules in one retained stylesheet.
#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_engine_stylesheet_rule_count(
    engine: *const StyloEngine,
    sheet_id: u64,
    out_count: *mut usize,
) -> StyloStatus {
    catch_unwind(AssertUnwindSafe(|| {
        if engine.is_null() || out_count.is_null() || sheet_id == 0 {
            return StyloStatus::NullPointer;
        }
        let Some(sheet) = unsafe { &*engine }
            .inner
            .sheets
            .iter()
            .find(|sheet| sheet.sheet_id == sheet_id)
        else {
            unsafe { *out_count = 0 };
            return StyloStatus::Ok;
        };
        let guard = sheet.sheet.shared_lock.read();
        unsafe {
            *out_count = sheet.sheet.contents.read_with(&guard).rules(&guard).len();
        }
        StyloStatus::Ok
    }))
    .unwrap_or(StyloStatus::Panic)
}

#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_engine_last_error(
    engine: *const StyloEngine,
    out: *mut u8,
    capacity: usize,
    written: *mut usize,
) -> StyloStatus {
    catch_unwind(AssertUnwindSafe(|| {
        if engine.is_null() {
            return StyloStatus::NullPointer;
        }
        copy_buffer(
            unsafe { (*engine).inner.last_error.as_bytes() },
            out,
            capacity,
            written,
        )
    }))
    .unwrap_or(StyloStatus::Panic)
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe extern "C" fn read_node(
        _ctx: *mut c_void,
        _node: *const c_void,
        out: *mut StyloNodeInfo,
    ) -> StyloStatus {
        unsafe { (*out).node_id = 7 };
        StyloStatus::Ok
    }

    fn callbacks() -> StyloDomCallbacks {
        StyloDomCallbacks {
            ctx: ptr::null_mut(),
            read_node: Some(read_node),
        }
    }

    #[test]
    fn replacement_is_atomic_and_generation_bumps_once() {
        let mut engine = Engine::new(callbacks());
        let css = b"div { color: red }";
        let input = StyloStylesheetInput {
            sheet_id: 1,
            origin: StyloStylesheetOrigin::Author,
            enabled: 1,
            reserved: [0; 7],
            css: StyloSlice {
                ptr: css.as_ptr(),
                len: css.len(),
            },
        };
        assert_eq!(engine.replace_stylesheets(&[input]), Ok(()));
        assert_eq!(engine.sheets.len(), 1);
        assert_eq!(engine.invalidation_generation, 1);
    }

    #[test]
    fn sync_reads_authoritative_callback() {
        let mut engine = Engine::new(callbacks());
        assert_eq!(
            engine.sync_node(1usize as *const c_void, None),
            StyloStatus::Ok
        );
        assert_eq!(engine.invalidation_generation, 1);
    }

    #[test]
    fn flush_is_explicitly_unsupported() {
        let mut engine = StyloEngine {
            inner: Engine::new(callbacks()),
        };
        let mut result = StyloFlushResult::default();
        assert_eq!(
            koko_stylo_engine_flush_styles(&mut engine, ptr::null(), 0, &mut result),
            StyloStatus::Unsupported
        );
    }

    #[test]
    fn specified_property_serialization_uses_stylo() {
        let mut engine = StyloEngine {
            inner: Engine::new(callbacks()),
        };
        let property = b"margin";
        let value = b"1px 2px";
        let mut output = [0u8; 32];
        let mut written = 0;
        assert_eq!(
            koko_stylo_engine_serialize_specified_property(
                &mut engine,
                StyloSlice {
                    ptr: property.as_ptr(),
                    len: property.len(),
                },
                StyloSlice {
                    ptr: value.as_ptr(),
                    len: value.len(),
                },
                output.as_mut_ptr(),
                output.len(),
                &mut written,
            ),
            StyloStatus::Ok
        );
        assert_eq!(&output[..written], b"1px 2px");
    }
}
