//! Minimal panic-safe C ABI around Stylo.
//!
//! The embedder owns the DOM. This crate stores opaque node handles and asks
//! the embedder for node data through callbacks; it never creates a duplicate
//! Rust DOM. Stylesheet replacement is parsed by Stylo itself and committed as
//! one batch. Traversal/property serialization remain explicit unsupported
//! operations until the full Stylo DOM trait adapter is wired.

use servo_arc::Arc;
use std::collections::HashMap;
use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

use style::context::QuirksMode;
use style::properties::{parse_style_attribute, PropertyId};
use style::selector_parser::PseudoElement;
use style::stylesheets::{CssRuleType, UrlExtraData};

mod dom_adapter;
mod stylist_store;

const ABI_VERSION: u32 = 2;

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
    pub first_child_id: u64,
    pub last_child_id: u64,
    pub prev_sibling_id: u64,
    pub next_sibling_id: u64,
    pub shadow_host_id: u64,
    pub shadow_root_id: u64,
    pub kind: u32,
    /// Event/state bits using `stylo_dom::ElementState` bit positions.
    pub flags: u64,
    /// UTF-8 byte length for character-data nodes; zero for other nodes.
    pub text_len: u32,
    pub tag_name: StyloSlice,
    /// Element namespace URI. Empty means no namespace (used by unit-test
    /// callback DOMs); HTML documents should provide the XHTML URI.
    pub namespace_name: StyloSlice,
    pub id: StyloSlice,
    pub classes: StyloSlice,
    pub style: StyloSlice,
    /// NUL-separated attribute names copied by the adapter during the callback.
    pub attribute_names: StyloSlice,
}

pub type StyloReadNodeCallback = unsafe extern "C" fn(
    ctx: *mut c_void,
    node: *const c_void,
    out: *mut StyloNodeInfo,
) -> StyloStatus;

pub type StyloReadAttrCallback = unsafe extern "C" fn(
    ctx: *mut c_void,
    node: *const c_void,
    name: StyloSlice,
    namespace: StyloSlice,
    out: *mut StyloSlice,
) -> StyloStatus;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct StyloDomCallbacks {
    pub ctx: *mut c_void,
    pub read_node: Option<StyloReadNodeCallback>,
    pub read_attr: Option<StyloReadAttrCallback>,
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
    /// Stable ShadowRoot node id; zero is the document scope.
    pub scope_id: u64,
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

struct Engine {
    callbacks: StyloDomCallbacks,
    /// One Stylo stylist per tree-scoped stylesheet set. Scope zero is the
    /// document; a ShadowRoot uses its stable node id as the scope key.
    stylists: HashMap<u64, stylist_store::StylistStore>,
    node_records: HashMap<u64, Box<dom_adapter::NodeRecord>>,
    computed_styles: HashMap<u64, Arc<style::properties::ComputedValues>>,
    url_data: UrlExtraData,
    invalidation_generation: u64,
    last_error: String,
}

impl Engine {
    fn new(callbacks: StyloDomCallbacks) -> Self {
        let mut stylists = HashMap::new();
        stylists.insert(0, stylist_store::StylistStore::new(1));
        Self {
            callbacks,
            stylists,
            node_records: HashMap::new(),
            computed_styles: HashMap::new(),
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

    pub(crate) fn ensure_node_record_mut(
        &mut self,
        node_id: u64,
    ) -> Option<&mut dom_adapter::NodeRecord> {
        if node_id == 0 {
            return None;
        }
        let callback = self.callbacks.read_node?;
        let mut info = StyloNodeInfo::default();
        let node = node_id as usize as *const c_void;
        let status = unsafe { callback(self.callbacks.ctx, node, &mut info) };
        if status != StyloStatus::Ok || info.node_id != node_id {
            return None;
        }
        if self.node_records.contains_key(&node_id) {
            let record = self.node_records.get_mut(&node_id)?;
            if record.matches(info) {
                return Some(record);
            }
            if !record.update(info) {
                return None;
            }
            return Some(record);
        }
        let record = dom_adapter::NodeRecord::new(info)?;
        self.node_records.insert(node_id, Box::new(record));
        self.node_records.get_mut(&node_id).map(Box::as_mut)
    }

    pub(crate) fn ensure_node_record(
        &mut self,
        node_id: u64,
    ) -> Option<&'static dom_adapter::NodeRecord> {
        let record = self.ensure_node_record_mut(node_id)? as *mut dom_adapter::NodeRecord;
        Some(unsafe { &*record })
    }

    fn replace_stylesheets(&mut self, inputs: &[StyloStylesheetInput]) -> Result<(), StyloStatus> {
        let mut grouped: HashMap<u64, Vec<StyloStylesheetInput>> = HashMap::new();
        for input in inputs {
            grouped.entry(input.scope_id).or_default().push(*input);
        }

        // Build every scope off to the side so a parse failure leaves the
        // previous document/shadow stylesheet snapshot intact.
        let mut next_stylists = HashMap::with_capacity(grouped.len().max(1));
        for (scope_id, scope_inputs) in grouped {
            let mut stylist = stylist_store::StylistStore::new(scope_id.max(1));
            stylist.replace(&scope_inputs)?;
            next_stylists.insert(scope_id, stylist);
        }
        next_stylists
            .entry(0)
            .or_insert_with(|| stylist_store::StylistStore::new(1));
        self.stylists = next_stylists;
        self.computed_styles.clear();
        self.invalidation_generation = self.invalidation_generation.wrapping_add(1);
        Ok(())
    }

    fn stylesheet_count(&self) -> usize {
        self.stylists
            .values()
            .map(stylist_store::StylistStore::stylesheet_count)
            .sum()
    }

    fn stylesheet_rule_count(&self, sheet_id: u64) -> usize {
        self.stylists
            .values()
            .map(|stylist| stylist.rule_count(sheet_id))
            .find(|count| *count != 0)
            .unwrap_or(0)
    }

    pub(crate) fn shared_lock(&self) -> &style::shared_lock::SharedRwLock {
        self.stylists
            .get(&0)
            .expect("document StylistStore is always present")
            .shared_lock()
    }

    fn invalidate_stylesheets(&mut self) {
        self.computed_styles.clear();
        self.invalidation_generation = self.invalidation_generation.wrapping_add(1);
        self.last_error.clear();
    }

    fn reset_document(&mut self) {
        self.node_records.clear();
        self.computed_styles.clear();
        self.invalidation_generation = self.invalidation_generation.wrapping_add(1);
        self.last_error.clear();
    }

    fn resolve_node_style(
        &mut self,
        engine_ptr: *mut StyloEngine,
        node_id: u64,
    ) -> Result<Arc<style::properties::ComputedValues>, StyloStatus> {
        if node_id == 0 {
            return Err(StyloStatus::InvalidArgument);
        }
        if let Some(style) = self.computed_styles.get(&node_id) {
            return Ok(style.clone());
        }
        let (kind, parent_id) = {
            let record = self
                .ensure_node_record(node_id)
                .ok_or(StyloStatus::CallbackFailed)?;
            (record.info.kind, record.info.parent_id)
        };
        if kind != dom_adapter::NODE_KIND_ELEMENT {
            return Err(StyloStatus::Unsupported);
        }
        // The authoritative DOM reports the document node as the parent of
        // the document element. It is not a style-bearing element, so stop
        // inheritance at that boundary. For a shadow root, inherit through
        // its host; the adapter exposes the same relationship through
        // `TElement::inheritance_parent`.
        let parent_style = if parent_id == 0 {
            None
        } else {
            let parent = self
                .ensure_node_record(parent_id)
                .ok_or(StyloStatus::CallbackFailed)?;
            match parent.info.kind {
                dom_adapter::NODE_KIND_ELEMENT => {
                    Some(self.resolve_node_style(engine_ptr, parent_id)?)
                }
                dom_adapter::NODE_KIND_SHADOW_ROOT if parent.info.shadow_host_id != 0 => {
                    Some(self.resolve_node_style(engine_ptr, parent.info.shadow_host_id)?)
                }
                _ => None,
            }
        };
        let scope_id = self.style_scope_for_node(node_id)?;
        let element = dom_adapter::KokoElement::from_engine_node(engine_ptr, node_id)
            .ok_or(StyloStatus::CallbackFailed)?;
        let stylist = self
            .stylists
            .get(&scope_id)
            .ok_or(StyloStatus::CallbackFailed)?;
        let resolved = stylist.resolve_element(
            engine_ptr,
            element,
            parent_style.as_deref(),
            parent_style.as_deref(),
        );
        let style = resolved.primary_style().clone();
        let record = self
            .ensure_node_record_mut(node_id)
            .ok_or(StyloStatus::CallbackFailed)?;
        record.data.borrow_mut().set_styles(resolved);
        self.computed_styles.insert(node_id, style.clone());
        Ok(style)
    }

    fn style_scope_for_node(&mut self, node_id: u64) -> Result<u64, StyloStatus> {
        let mut current = node_id;
        for _ in 0..4096 {
            let parent_id = self
                .ensure_node_record(current)
                .ok_or(StyloStatus::CallbackFailed)?
                .info
                .parent_id;
            if parent_id == 0 {
                return Ok(0);
            }
            let parent = self
                .ensure_node_record(parent_id)
                .ok_or(StyloStatus::CallbackFailed)?;
            if parent.info.kind == dom_adapter::NODE_KIND_SHADOW_ROOT {
                return Ok(parent.info.node_id);
            }
            current = parent_id;
        }
        Err(StyloStatus::CallbackFailed)
    }

    fn serialize_pseudo_property(
        &mut self,
        engine_ptr: *mut StyloEngine,
        node_id: u64,
        pseudo: StyloSlice,
        property: StyloSlice,
        out: *mut u8,
        capacity: usize,
        written: *mut usize,
    ) -> StyloStatus {
        let pseudo_name = match pseudo.as_str() {
            Ok(value) => value.trim(),
            Err(status) => return self.error(status, "pseudo-element is not UTF-8"),
        };
        let pseudo = match pseudo_name.to_ascii_lowercase().as_str() {
            ":before" | "::before" => PseudoElement::Before,
            ":after" | "::after" => PseudoElement::After,
            ":first-letter" | "::first-letter" => PseudoElement::FirstLetter,
            ":first-line" | "::first-line" => PseudoElement::FirstLine,
            ":selection" | "::selection" => PseudoElement::Selection,
            ":marker" | "::marker" => PseudoElement::Marker,
            _ => return self.error(StyloStatus::Unsupported, "unsupported pseudo-element"),
        };
        if let Err(status) = self.resolve_node_style(engine_ptr, node_id) {
            return self.error(status, "pseudo style resolution failed");
        }
        let property = match property.as_str() {
            Ok(value) if !value.is_empty() => value,
            Ok(_) => return self.error(StyloStatus::InvalidArgument, "property is empty"),
            Err(status) => return self.error(status, "property is not UTF-8"),
        };
        let property_id = match PropertyId::parse_enabled_for_all_content(property) {
            Ok(property_id) => property_id,
            Err(()) => return self.error(StyloStatus::ParseError, "unknown property"),
        };
        let style = self
            .node_records
            .get(&node_id)
            .map(|record| record.data.borrow().styles.pseudos.get(&pseudo).cloned())
            .flatten();
        let Some(style) = style else {
            if !self.node_records.contains_key(&node_id) {
                return self.error(StyloStatus::CallbackFailed, "pseudo node is missing");
            }
            return self.error(
                StyloStatus::Unsupported,
                "pseudo-element has no computed style",
            );
        };
        let scope_id = match self.style_scope_for_node(node_id) {
            Ok(scope_id) => scope_id,
            Err(status) => return self.error(status, "pseudo scope is missing"),
        };
        let stylist = match self.stylists.get(&scope_id) {
            Some(stylist) => stylist,
            None => return self.error(StyloStatus::CallbackFailed, "pseudo scope is missing"),
        };
        let serialized = match stylist.serialize_computed_property(&style, &property_id) {
            Ok(value) => value,
            Err(status) => return self.error(status, "pseudo property is not a longhand"),
        };
        let status = copy_buffer(serialized.as_bytes(), out, capacity, written);
        if status != StyloStatus::Ok {
            return self.error(status, "pseudo property output buffer is too small");
        }
        self.last_error.clear();
        StyloStatus::Ok
    }

    fn flush_styles(
        &mut self,
        engine_ptr: *mut StyloEngine,
        nodes: &[u64],
    ) -> Result<usize, StyloStatus> {
        for stylist in self.stylists.values_mut() {
            stylist.flush();
        }
        let mut changed = 0;
        for node_id in nodes {
            self.resolve_node_style(engine_ptr, *node_id)?;
            changed += 1;
        }
        Ok(changed)
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
        if self
            .ensure_node_record_mut(unsafe { (*info).node_id })
            .is_none()
        {
            return self.error(StyloStatus::CallbackFailed, "node metadata is invalid");
        }
        self.computed_styles.clear();
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
pub extern "C" fn koko_stylo_engine_invalidate_stylesheets(
    engine: *mut StyloEngine,
) -> StyloStatus {
    match with_engine(engine, |inner| {
        inner.invalidate_stylesheets();
        StyloStatus::Ok
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

#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_engine_reset_document(engine: *mut StyloEngine) -> StyloStatus {
    match with_engine(engine, |inner| {
        inner.reset_document();
        StyloStatus::Ok
    }) {
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
        let node_slice = if node_count == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(nodes, node_count) }
        };
        let changed_node_count = match inner.flush_styles(engine, node_slice) {
            Ok(count) => count,
            Err(status) => return inner.error(status, "style flush requires DOM traversal"),
        };
        unsafe {
            *out_result = StyloFlushResult {
                invalidation_generation: inner.invalidation_generation,
                changed_node_count,
            };
        }
        inner.last_error.clear();
        StyloStatus::Ok
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
        let property = match property.as_str() {
            Ok(property) => property,
            Err(status) => return inner.error(status, "property is not UTF-8"),
        };
        let property_id = match PropertyId::parse_enabled_for_all_content(property) {
            Ok(property_id) => property_id,
            Err(()) => return inner.error(StyloStatus::ParseError, "unknown property"),
        };
        let computed = match inner.resolve_node_style(engine, node_id) {
            Ok(style) => style,
            Err(status) => return inner.error(status, "computed style resolution failed"),
        };
        let scope_id = match inner.style_scope_for_node(node_id) {
            Ok(scope_id) => scope_id,
            Err(status) => return inner.error(status, "computed scope is missing"),
        };
        let stylist = match inner.stylists.get(&scope_id) {
            Some(stylist) => stylist,
            None => return inner.error(StyloStatus::CallbackFailed, "computed scope is missing"),
        };
        let serialized = match stylist.serialize_computed_property(&computed, &property_id) {
            Ok(value) => value,
            Err(status) => return inner.error(status, "property is not a longhand"),
        };
        let status = copy_buffer(serialized.as_bytes(), out, capacity, written);
        if status != StyloStatus::Ok {
            return inner.error(status, "computed property output buffer is too small");
        }
        inner.last_error.clear();
        StyloStatus::Ok
    }) {
        Ok(status) | Err(status) => status,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn koko_stylo_engine_serialize_pseudo_property(
    engine: *mut StyloEngine,
    node_id: u64,
    pseudo: StyloSlice,
    property: StyloSlice,
    out: *mut u8,
    capacity: usize,
    written: *mut usize,
) -> StyloStatus {
    match with_engine(engine, |inner| {
        if node_id == 0 {
            return inner.error(StyloStatus::InvalidArgument, "node_id is zero");
        }
        if written.is_null() {
            return inner.error(StyloStatus::NullPointer, "written is null");
        }
        inner.serialize_pseudo_property(engine, node_id, pseudo, property, out, capacity, written)
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
        unsafe { *out_count = (*engine).inner.stylesheet_count() };
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
        unsafe { *out_count = (*engine).inner.stylesheet_rule_count(sheet_id) };
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

    unsafe extern "C" fn read_node_tree(
        _ctx: *mut c_void,
        node: *const c_void,
        out: *mut StyloNodeInfo,
    ) -> StyloStatus {
        let node_id = node as usize as u64;
        let (tag, parent) = if node_id == 1 {
            (b"main" as &[u8], 0)
        } else {
            (b"div" as &[u8], 1)
        };
        let id = if node_id == 2 {
            b"stylo-target" as &[u8]
        } else {
            &[]
        };
        let inline = if node_id == 2 {
            b"color: blue" as &[u8]
        } else {
            &[]
        };
        let attribute_names = if node_id == 2 {
            b"data-kind\0" as &[u8]
        } else {
            &[]
        };
        let namespace = b"http://www.w3.org/1999/xhtml";
        unsafe {
            (*out).node_id = node_id;
            (*out).parent_id = parent;
            (*out).kind = dom_adapter::NODE_KIND_ELEMENT;
            (*out).tag_name = StyloSlice {
                ptr: tag.as_ptr(),
                len: tag.len(),
            };
            (*out).id = StyloSlice {
                ptr: if id.is_empty() {
                    ptr::null()
                } else {
                    id.as_ptr()
                },
                len: id.len(),
            };
            (*out).namespace_name = StyloSlice {
                ptr: namespace.as_ptr(),
                len: namespace.len(),
            };
            (*out).style = StyloSlice {
                ptr: if inline.is_empty() {
                    ptr::null()
                } else {
                    inline.as_ptr()
                },
                len: inline.len(),
            };
            (*out).attribute_names = StyloSlice {
                ptr: if attribute_names.is_empty() {
                    ptr::null()
                } else {
                    attribute_names.as_ptr()
                },
                len: attribute_names.len(),
            };
        }
        StyloStatus::Ok
    }

    unsafe extern "C" fn read_attr_tree(
        _ctx: *mut c_void,
        _node: *const c_void,
        name: StyloSlice,
        _namespace: StyloSlice,
        out: *mut StyloSlice,
    ) -> StyloStatus {
        let Ok(name) = name.as_str() else {
            return StyloStatus::InvalidUtf8;
        };
        if name != "data-kind" {
            unsafe { *out = StyloSlice::default() };
            return StyloStatus::Ok;
        }
        let value = b"primary";
        unsafe {
            *out = StyloSlice {
                ptr: value.as_ptr(),
                len: value.len(),
            };
        }
        StyloStatus::Ok
    }

    fn callbacks() -> StyloDomCallbacks {
        StyloDomCallbacks {
            ctx: ptr::null_mut(),
            read_node: Some(read_node),
            read_attr: None,
        }
    }

    fn tree_callbacks() -> StyloDomCallbacks {
        StyloDomCallbacks {
            ctx: ptr::null_mut(),
            read_node: Some(read_node_tree),
            read_attr: Some(read_attr_tree),
        }
    }

    #[test]
    fn replacement_is_atomic_and_generation_bumps_once() {
        let mut engine = Engine::new(callbacks());
        let css = b"div { color: red }";
        let input = StyloStylesheetInput {
            sheet_id: 1,
            scope_id: 0,
            origin: StyloStylesheetOrigin::Author,
            enabled: 1,
            reserved: [0; 7],
            css: StyloSlice {
                ptr: css.as_ptr(),
                len: css.len(),
            },
        };
        assert_eq!(engine.replace_stylesheets(&[input]), Ok(()));
        assert_eq!(engine.stylesheet_count(), 1);
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
    fn flush_without_nodes_builds_cascade_data() {
        let mut engine = StyloEngine {
            inner: Engine::new(callbacks()),
        };
        let mut result = StyloFlushResult::default();
        assert_eq!(
            koko_stylo_engine_flush_styles(&mut engine, ptr::null(), 0, &mut result),
            StyloStatus::Ok
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

    #[test]
    fn flush_resolves_computed_values_through_callback_dom() {
        let mut engine = StyloEngine {
            inner: Engine::new(tree_callbacks()),
        };
        let css = b"div[data-kind=\"primary\"] { --brand: red; background-color: var(--brand); margin-top: 3px } main > div[data-kind=\"primary\"] { color: rgb(70, 80, 90) !important } div::before { content: \"stylo\"; display: inline-block }";
        let input = StyloStylesheetInput {
            sheet_id: 1,
            scope_id: 0,
            origin: StyloStylesheetOrigin::Author,
            enabled: 1,
            reserved: [0; 7],
            css: StyloSlice {
                ptr: css.as_ptr(),
                len: css.len(),
            },
        };
        assert_eq!(
            koko_stylo_engine_replace_stylesheets(&mut engine, &input, 1),
            StyloStatus::Ok
        );
        let nodes = [2u64];
        let mut result = StyloFlushResult::default();
        assert_eq!(
            koko_stylo_engine_flush_styles(&mut engine, nodes.as_ptr(), nodes.len(), &mut result),
            StyloStatus::Ok
        );
        assert_eq!(result.changed_node_count, 1);

        let property = b"margin-top";
        let mut output = [0u8; 64];
        let mut written = 0;
        assert_eq!(
            koko_stylo_engine_serialize_property(
                &mut engine,
                2,
                StyloSlice {
                    ptr: property.as_ptr(),
                    len: property.len(),
                },
                output.as_mut_ptr(),
                output.len(),
                &mut written,
            ),
            StyloStatus::Ok
        );
        assert_eq!(&output[..written], b"3px");

        let property = b"color";
        let mut output = [0u8; 64];
        let mut written = 0;
        assert_eq!(
            koko_stylo_engine_serialize_property(
                &mut engine,
                2,
                StyloSlice {
                    ptr: property.as_ptr(),
                    len: property.len(),
                },
                output.as_mut_ptr(),
                output.len(),
                &mut written,
            ),
            StyloStatus::Ok
        );
        assert_eq!(&output[..written], b"rgb(70, 80, 90)");

        let property = b"--brand";
        let mut output = [0u8; 64];
        let mut written = 0;
        assert_eq!(
            koko_stylo_engine_serialize_property(
                &mut engine,
                2,
                StyloSlice {
                    ptr: property.as_ptr(),
                    len: property.len(),
                },
                output.as_mut_ptr(),
                output.len(),
                &mut written,
            ),
            StyloStatus::Ok
        );
        assert_eq!(&output[..written], b"red");

        let pseudo = b"::before";
        let property = b"display";
        let mut output = [0u8; 64];
        let mut written = 0;
        assert_eq!(
            koko_stylo_engine_serialize_pseudo_property(
                &mut engine,
                2,
                StyloSlice {
                    ptr: pseudo.as_ptr(),
                    len: pseudo.len(),
                },
                StyloSlice {
                    ptr: property.as_ptr(),
                    len: property.len(),
                },
                output.as_mut_ptr(),
                output.len(),
                &mut written,
            ),
            StyloStatus::Ok
        );
        assert_eq!(&output[..written], b"inline-block");
    }
}
