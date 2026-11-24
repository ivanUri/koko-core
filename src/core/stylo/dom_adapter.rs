//! Callback-backed Stylo DOM handles.
//!
//! Handles are copyable identities into Koko's authoritative Zig DOM. The
//! adapter owns only Stylo's per-element data sidecar; it never builds a Rust
//! DOM tree. Callback bytes are copied into stable records before any Stylo
//! trait method returns a borrowed atom or name.

#![allow(unsafe_code)]

use std::cell::Cell;
use std::hash::Hash;
use std::ptr::NonNull;

use selectors::attr::{AttrSelectorOperation, CaseSensitivity, NamespaceConstraint};
use selectors::bloom::BloomFilter;
use selectors::matching::{ElementSelectorFlags, MatchingContext, VisitedHandlingMode};
use selectors::parser::SelectorImpl as SelectorImplTrait;
use selectors::sink::Push;
use selectors::{Element as SelectorsElement, OpaqueElement};
use servo_arc::{Arc, ArcBorrow};
use style::applicable_declarations::ApplicableDeclarationBlock;
use style::context::{SharedStyleContext, TreeCountingCaches};
use style::data::{ElementDataMut, ElementDataRef, ElementDataWrapper};
use style::dom::{NodeInfo, TDocument, TElement, TNode, TShadowRoot};
use style::properties::PropertyDeclarationBlock;
use style::selector_parser::{AttrValue, Lang, PseudoElement, SelectorImpl};
use style::shared_lock::{Locked, SharedRwLock};
use style::stylist::CascadeData;
use style::values::AtomIdent;
use style::{LocalName, Namespace};
use style_traits::dom::OpaqueNode;
use stylo_atoms::Atom as WeakAtom;
use stylo_dom::ElementState;

use super::{StyloEngine, StyloNodeInfo};

pub(crate) const NODE_KIND_ELEMENT: u32 = 1;
const NODE_KIND_TEXT: u32 = 2;
const NODE_KIND_SHADOW_ROOT: u32 = 3;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct KokoNode {
    pub(crate) node_id: u64,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct KokoElement {
    node: KokoNode,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct KokoDocument {}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct KokoShadowRoot {
    node: KokoNode,
}

/// Stable, owned metadata for one callback-backed element.
pub(crate) struct NodeRecord {
    pub(crate) info: StyloNodeInfo,
    pub(crate) tag: String,
    pub(crate) id: String,
    pub(crate) classes: Vec<String>,
    pub(crate) style: String,
    pub(crate) attribute_names: Vec<String>,
    pub(crate) tag_atom: LocalName,
    pub(crate) namespace_atom: Namespace,
    pub(crate) id_atom: Option<WeakAtom>,
    pub(crate) class_atoms: Vec<AtomIdent>,
    pub(crate) data: ElementDataWrapper,
    pub(crate) style_attribute: Option<Arc<Locked<PropertyDeclarationBlock>>>,
    pub(crate) children_to_process: Cell<isize>,
}

impl NodeRecord {
    pub(crate) fn new(info: StyloNodeInfo) -> Option<Self> {
        let tag = slice_string(info.tag_name)?;
        let id = slice_string(info.id)?;
        let class_text = slice_string(info.classes)?;
        let style = slice_string(info.style)?;
        let attribute_names = slice_list(info.attribute_names)?;
        let classes = class_text
            .split_ascii_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let tag_atom = LocalName::from(tag.as_str());
        let id_atom = (!id.is_empty()).then(|| WeakAtom::from(id.as_str()));
        let class_atoms = classes
            .iter()
            .map(|class| AtomIdent::from(class.as_str()))
            .collect();
        Some(Self {
            info,
            tag,
            id,
            classes,
            style,
            tag_atom,
            id_atom,
            class_atoms,
            attribute_names,
            namespace_atom: Namespace::from(""),
            data: ElementDataWrapper::default(),
            style_attribute: None,
            children_to_process: Cell::new(0),
        })
    }

    pub(crate) fn update(&mut self, info: StyloNodeInfo) -> bool {
        let Some(next) = Self::new(info) else {
            return false;
        };
        self.info = next.info;
        self.tag = next.tag;
        self.id = next.id;
        self.classes = next.classes;
        self.style = next.style;
        self.tag_atom = next.tag_atom;
        self.id_atom = next.id_atom;
        self.class_atoms = next.class_atoms;
        self.attribute_names = next.attribute_names;
        self.style_attribute = None;
        true
    }

    pub(crate) fn matches(&self, info: StyloNodeInfo) -> bool {
        self.info.node_id == info.node_id
            && self.info.parent_id == info.parent_id
            && self.info.first_child_id == info.first_child_id
            && self.info.last_child_id == info.last_child_id
            && self.info.prev_sibling_id == info.prev_sibling_id
            && self.info.next_sibling_id == info.next_sibling_id
            && self.info.kind == info.kind
            && self.info.flags == info.flags
            && slice_matches(info.tag_name, &self.tag)
            && slice_matches(info.id, &self.id)
            && slice_matches(info.classes, &self.classes.join(" "))
            && slice_matches(info.style, &self.style)
            && slice_list(info.attribute_names).is_some_and(|names| names == self.attribute_names)
    }
}

fn slice_matches(slice: super::StyloSlice, expected: &str) -> bool {
    slice_string(slice).is_some_and(|value| value == expected)
}

pub(crate) fn slice_string(slice: super::StyloSlice) -> Option<String> {
    if slice.len == 0 {
        return Some(String::new());
    }
    if slice.ptr.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(slice.ptr, slice.len) };
    std::str::from_utf8(bytes).ok().map(str::to_owned)
}

fn slice_list(slice: super::StyloSlice) -> Option<Vec<String>> {
    if slice.len == 0 {
        return Some(Vec::new());
    }
    if slice.ptr.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(slice.ptr, slice.len) };
    bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| std::str::from_utf8(part).ok().map(str::to_owned))
        .collect()
}

fn handle_node(engine: *mut StyloEngine, node_id: u64) -> Option<KokoNode> {
    (!engine.is_null() && node_id != 0).then_some(KokoNode { node_id })
}

fn current_engine() -> Option<*mut StyloEngine> {
    let engine = CURRENT_ENGINE.with(Cell::get);
    (!engine.is_null()).then_some(engine)
}

thread_local! {
    static CURRENT_ENGINE: Cell<*mut StyloEngine> = const { Cell::new(std::ptr::null_mut()) };
}

pub(crate) struct EngineScope {
    previous: *mut StyloEngine,
}

impl EngineScope {
    pub(crate) fn enter(engine: *mut StyloEngine) -> Self {
        let previous = CURRENT_ENGINE.with(|current| {
            let previous = current.get();
            current.set(engine);
            previous
        });
        Self { previous }
    }
}

impl Drop for EngineScope {
    fn drop(&mut self) {
        CURRENT_ENGINE.with(|current| current.set(self.previous));
    }
}

impl KokoNode {
    fn read(&self) -> Option<&'static NodeRecord> {
        let engine = CURRENT_ENGINE.with(Cell::get);
        if engine.is_null() {
            return None;
        }
        unsafe { (&mut *engine).inner.ensure_node_record(self.node_id) }
    }

    fn kind(&self) -> Option<u32> {
        self.read().map(|record| record.info.kind)
    }

    fn element(&self) -> Option<KokoElement> {
        (self.kind() == Some(NODE_KIND_ELEMENT)).then_some(KokoElement { node: *self })
    }

    fn document(&self) -> KokoDocument {
        KokoDocument {}
    }

    fn opaque_element(&self) -> Option<OpaqueElement> {
        NonNull::new(self.node_id as usize as *mut ()).map(OpaqueElement::from_ptr)
    }
}

impl KokoElement {
    pub(crate) fn from_engine_node(engine: *mut StyloEngine, node_id: u64) -> Option<Self> {
        handle_node(engine, node_id).map(|node| Self { node })
    }

    fn record(&self) -> Option<&'static NodeRecord> {
        self.node.read()
    }

    fn record_mut(&self) -> Option<&'static mut NodeRecord> {
        let engine = CURRENT_ENGINE.with(Cell::get);
        if engine.is_null() {
            return None;
        }
        unsafe {
            (&mut *engine)
                .inner
                .ensure_node_record_mut(self.node.node_id)
        }
    }

    pub(crate) fn as_node(&self) -> KokoNode {
        self.node
    }
}

impl KokoDocument {
    fn shared_lock(&self) -> &'static SharedRwLock {
        let engine = CURRENT_ENGINE.with(Cell::get);
        assert!(
            !engine.is_null(),
            "Stylo engine is not active on this thread"
        );
        unsafe { (&*engine).inner.stylist.shared_lock() }
    }
}

impl NodeInfo for KokoNode {
    fn is_element(&self) -> bool {
        self.kind() == Some(NODE_KIND_ELEMENT)
    }

    fn is_text_node(&self) -> bool {
        self.kind() == Some(NODE_KIND_TEXT)
    }
}

impl TDocument for KokoDocument {
    type ConcreteNode = KokoNode;

    fn as_node(&self) -> Self::ConcreteNode {
        KokoNode { node_id: 0 }
    }

    fn is_html_document(&self) -> bool {
        true
    }

    fn quirks_mode(&self) -> selectors::matching::QuirksMode {
        selectors::matching::QuirksMode::NoQuirks
    }

    fn elements_with_id<'a>(
        &self,
        _id: &AtomIdent,
    ) -> Result<&'a [<Self::ConcreteNode as TNode>::ConcreteElement], ()>
    where
        Self: 'a,
    {
        Err(())
    }

    fn shared_lock(&self) -> &SharedRwLock {
        KokoDocument::shared_lock(self)
    }
}

impl TNode for KokoNode {
    type ConcreteElement = KokoElement;
    type ConcreteDocument = KokoDocument;
    type ConcreteShadowRoot = KokoShadowRoot;

    fn parent_node(&self) -> Option<Self> {
        let parent = self.read()?.info.parent_id;
        let engine = CURRENT_ENGINE.with(Cell::get);
        handle_node(engine, parent)
    }

    fn first_child(&self) -> Option<Self> {
        let child = self.read()?.info.first_child_id;
        let engine = CURRENT_ENGINE.with(Cell::get);
        handle_node(engine, child)
    }

    fn last_child(&self) -> Option<Self> {
        let child = self.read()?.info.last_child_id;
        let engine = CURRENT_ENGINE.with(Cell::get);
        handle_node(engine, child)
    }

    fn prev_sibling(&self) -> Option<Self> {
        let sibling = self.read()?.info.prev_sibling_id;
        let engine = CURRENT_ENGINE.with(Cell::get);
        handle_node(engine, sibling)
    }

    fn next_sibling(&self) -> Option<Self> {
        let sibling = self.read()?.info.next_sibling_id;
        let engine = CURRENT_ENGINE.with(Cell::get);
        handle_node(engine, sibling)
    }

    fn owner_doc(&self) -> Self::ConcreteDocument {
        self.document()
    }

    fn is_in_document(&self) -> bool {
        self.read().is_some()
    }

    fn traversal_parent(&self) -> Option<Self::ConcreteElement> {
        self.parent_node().and_then(|node| node.element())
    }

    fn opaque(&self) -> OpaqueNode {
        OpaqueNode(self.node_id as usize)
    }

    fn debug_id(self) -> usize {
        self.node_id as usize
    }

    fn as_element(&self) -> Option<Self::ConcreteElement> {
        self.element()
    }

    fn as_document(&self) -> Option<Self::ConcreteDocument> {
        (self.node_id == 0).then(|| self.document())
    }

    fn as_shadow_root(&self) -> Option<Self::ConcreteShadowRoot> {
        (self.kind() == Some(NODE_KIND_SHADOW_ROOT)).then_some(KokoShadowRoot { node: *self })
    }
}

impl TShadowRoot for KokoShadowRoot {
    type ConcreteNode = KokoNode;

    fn as_node(&self) -> Self::ConcreteNode {
        self.node
    }

    fn host(&self) -> <Self::ConcreteNode as TNode>::ConcreteElement {
        panic!("shadow-root host callback is not available")
    }

    fn style_data<'a>(&self) -> Option<&'a CascadeData>
    where
        Self: 'a,
    {
        None
    }
}

impl SelectorsElement for KokoElement {
    type Impl = SelectorImpl;

    fn opaque(&self) -> OpaqueElement {
        self.node
            .opaque_element()
            .expect("element node id must be non-zero")
    }

    fn parent_element(&self) -> Option<Self> {
        self.node.parent_node().and_then(|node| node.element())
    }

    fn parent_node_is_shadow_root(&self) -> bool {
        self.node.parent_node().and_then(|node| node.kind()) == Some(NODE_KIND_SHADOW_ROOT)
    }

    fn containing_shadow_host(&self) -> Option<Self> {
        None
    }

    fn is_pseudo_element(&self) -> bool {
        false
    }

    fn prev_sibling_element(&self) -> Option<Self> {
        let mut current = self.node.prev_sibling();
        while let Some(node) = current {
            if let Some(element) = node.element() {
                return Some(element);
            }
            current = node.prev_sibling();
        }
        None
    }

    fn next_sibling_element(&self) -> Option<Self> {
        let mut current = self.node.next_sibling();
        while let Some(node) = current {
            if let Some(element) = node.element() {
                return Some(element);
            }
            current = node.next_sibling();
        }
        None
    }

    fn first_element_child(&self) -> Option<Self> {
        let mut current = self.node.first_child();
        while let Some(node) = current {
            if let Some(element) = node.element() {
                return Some(element);
            }
            current = node.next_sibling();
        }
        None
    }

    fn is_html_element_in_html_document(&self) -> bool {
        self.is_html_element()
    }

    fn has_local_name(
        &self,
        local_name: &<Self::Impl as SelectorImplTrait>::BorrowedLocalName,
    ) -> bool {
        self.record()
            .is_some_and(|record| record.tag_atom.0 == *local_name)
    }

    fn has_namespace(&self, ns: &<Self::Impl as SelectorImplTrait>::BorrowedNamespaceUrl) -> bool {
        let namespace: &str = ns.as_ref();
        namespace.is_empty()
    }

    fn is_same_type(&self, other: &Self) -> bool {
        self.record()
            .zip(other.record())
            .is_some_and(|(a, b)| a.tag == b.tag)
    }

    fn attr_matches(
        &self,
        ns: &NamespaceConstraint<&<Self::Impl as SelectorImplTrait>::NamespaceUrl>,
        local_name: &<Self::Impl as SelectorImplTrait>::LocalName,
        operation: &AttrSelectorOperation<&<Self::Impl as SelectorImplTrait>::AttrValue>,
    ) -> bool {
        if !matches!(
            ns,
            NamespaceConstraint::Any | NamespaceConstraint::Specific(_)
        ) {
            return false;
        }
        if let NamespaceConstraint::Specific(namespace) = ns {
            let namespace_text: &str = namespace.as_ref();
            if !namespace_text.is_empty() {
                return false;
            }
        }
        self.get_attr(local_name, &Namespace::from(""))
            .is_some_and(|value| operation.eval_str(&value))
    }

    fn match_non_ts_pseudo_class(
        &self,
        _pc: &<Self::Impl as SelectorImplTrait>::NonTSPseudoClass,
        _context: &mut MatchingContext<Self::Impl>,
    ) -> bool {
        false
    }

    fn match_pseudo_element(
        &self,
        _pe: &<Self::Impl as SelectorImplTrait>::PseudoElement,
        _context: &mut MatchingContext<Self::Impl>,
    ) -> bool {
        false
    }

    fn apply_selector_flags(&self, _flags: ElementSelectorFlags) {}

    fn is_link(&self) -> bool {
        false
    }

    fn is_html_slot_element(&self) -> bool {
        false
    }

    fn has_id(&self, id: &AtomIdent, _case_sensitivity: CaseSensitivity) -> bool {
        self.record().is_some_and(|record| record.id == id.as_ref())
    }

    fn has_class(&self, name: &AtomIdent, _case_sensitivity: CaseSensitivity) -> bool {
        let needle: &str = name.as_ref();
        self.record()
            .is_some_and(|record| record.classes.iter().any(|class| class == needle))
    }

    fn has_custom_state(&self, _name: &AtomIdent) -> bool {
        false
    }

    fn imported_part(&self, _name: &AtomIdent) -> Option<AtomIdent> {
        None
    }

    fn is_part(&self, _name: &AtomIdent) -> bool {
        false
    }

    fn is_empty(&self) -> bool {
        self.node.first_child().is_none()
    }

    fn is_root(&self) -> bool {
        self.parent_element().is_none()
    }

    fn add_element_unique_hashes(&self, _filter: &mut BloomFilter) -> bool {
        false
    }
}

impl TElement for KokoElement {
    type ConcreteNode = KokoNode;
    type TraversalChildrenIterator = std::vec::IntoIter<KokoNode>;

    fn as_node(&self) -> Self::ConcreteNode {
        self.as_node()
    }

    fn traversal_children(&self) -> style::dom::LayoutIterator<Self::TraversalChildrenIterator> {
        let mut children = Vec::new();
        let mut current = self.node.first_child();
        while let Some(node) = current {
            children.push(node);
            current = node.next_sibling();
        }
        style::dom::LayoutIterator(children.into_iter())
    }

    fn is_html_element(&self) -> bool {
        true
    }

    fn is_mathml_element(&self) -> bool {
        false
    }

    fn is_svg_element(&self) -> bool {
        false
    }

    fn style_attribute(&self) -> Option<ArcBorrow<'_, Locked<PropertyDeclarationBlock>>> {
        let record = self.record()?;
        if record.style.is_empty() {
            return None;
        }
        if record.style_attribute.is_none() {
            let engine = current_engine()?;
            let parsed = {
                let inner = unsafe { &mut (*engine).inner };
                let block = style::properties::parse_style_attribute(
                    &record.style,
                    &inner.url_data,
                    None,
                    selectors::matching::QuirksMode::NoQuirks,
                    style::stylesheets::CssRuleType::Style,
                );
                Arc::new(inner.stylist.shared_lock().wrap(block))
            };
            self.record_mut()?.style_attribute = Some(parsed);
        }
        self.record()?
            .style_attribute
            .as_ref()
            .map(|value| unsafe { ArcBorrow::from_ref(&**value) })
    }

    fn animation_rule(
        &self,
        _context: &SharedStyleContext,
    ) -> Option<servo_arc::Arc<Locked<PropertyDeclarationBlock>>> {
        None
    }

    fn transition_rule(
        &self,
        _context: &SharedStyleContext,
    ) -> Option<servo_arc::Arc<Locked<PropertyDeclarationBlock>>> {
        None
    }

    fn state(&self) -> ElementState {
        ElementState::empty()
    }

    fn has_part_attr(&self) -> bool {
        false
    }

    fn synthesize_presentational_hints_for_legacy_attributes<'a, V>(
        &self,
        _visited_handling: VisitedHandlingMode,
        _hints: &mut V,
    ) where
        V: Push<ApplicableDeclarationBlock<'a>>,
        Self: 'a,
    {
    }
    fn exports_any_part(&self) -> bool {
        false
    }

    fn id(&self) -> Option<&WeakAtom> {
        self.record()?.id_atom.as_ref()
    }

    fn each_class<F>(&self, mut callback: F)
    where
        F: FnMut(&AtomIdent),
    {
        if let Some(record) = self.record() {
            for class in &record.class_atoms {
                callback(class);
            }
        }
    }

    fn each_custom_state<F>(&self, _callback: F)
    where
        F: FnMut(&AtomIdent),
    {
    }

    fn each_attr_name<F>(&self, mut callback: F)
    where
        F: FnMut(&LocalName),
    {
        if let Some(record) = self.record() {
            for name in &record.attribute_names {
                callback(&LocalName::from(name.as_str()));
            }
        }
    }

    fn has_dirty_descendants(&self) -> bool {
        false
    }
    fn has_snapshot(&self) -> bool {
        false
    }
    fn handled_snapshot(&self) -> bool {
        true
    }
    unsafe fn set_handled_snapshot(&self) {}
    unsafe fn set_dirty_descendants(&self) {}
    unsafe fn unset_dirty_descendants(&self) {}
    fn store_children_to_process(&self, n: isize) {
        if let Some(record) = self.record() {
            record.children_to_process.set(n);
        }
    }
    fn did_process_child(&self) -> isize {
        self.record()
            .map(|record| {
                let next = record.children_to_process.get() - 1;
                record.children_to_process.set(next);
                next
            })
            .unwrap_or(0)
    }
    unsafe fn ensure_data(&self) -> ElementDataMut<'_> {
        self.record_mut().expect("element record").data.borrow_mut()
    }
    unsafe fn clear_data(&self) {}
    fn has_data(&self) -> bool {
        self.record().is_some()
    }
    fn borrow_data(&self) -> Option<ElementDataRef<'_>> {
        self.record().map(|record| record.data.borrow())
    }
    fn mutate_data(&self) -> Option<ElementDataMut<'_>> {
        self.record_mut().map(|record| record.data.borrow_mut())
    }
    fn skip_item_display_fixup(&self) -> bool {
        false
    }
    fn may_have_animations(&self) -> bool {
        false
    }
    fn set_may_have_animations(&self) {}
    fn has_animations(&self, _context: &SharedStyleContext) -> bool {
        false
    }
    fn has_css_animations(
        &self,
        _context: &SharedStyleContext,
        _pseudo: Option<PseudoElement>,
    ) -> bool {
        false
    }
    fn has_css_transitions(
        &self,
        _context: &SharedStyleContext,
        _pseudo: Option<PseudoElement>,
    ) -> bool {
        false
    }
    fn shadow_root(&self) -> Option<KokoShadowRoot> {
        None
    }
    fn containing_shadow(&self) -> Option<KokoShadowRoot> {
        None
    }
    fn lang_attr(&self) -> Option<AttrValue> {
        None
    }
    fn match_element_lang(&self, _override_lang: Option<Option<AttrValue>>, _value: &Lang) -> bool {
        false
    }
    fn is_html_document_body_element(&self) -> bool {
        self.record()
            .is_some_and(|record| record.tag.eq_ignore_ascii_case("body"))
    }
    fn local_name(&self) -> &<SelectorImpl as SelectorImplTrait>::BorrowedLocalName {
        &self.record().expect("element record").tag_atom
    }
    fn namespace(&self) -> &<SelectorImpl as SelectorImplTrait>::BorrowedNamespaceUrl {
        &self.record().expect("element record").namespace_atom.0
    }
    fn query_container_size(
        &self,
        _display: &style::values::computed::Display,
    ) -> euclid::default::Size2D<Option<app_units::Au>> {
        euclid::default::Size2D::new(None, None)
    }
    fn has_selector_flags(&self, _flags: ElementSelectorFlags) -> bool {
        false
    }
    fn relative_selector_search_direction(&self) -> ElementSelectorFlags {
        ElementSelectorFlags::empty()
    }
    fn get_attr(&self, attr: &LocalName, namespace: &Namespace) -> Option<String> {
        let namespace_text: &str = &namespace.0;
        if !namespace_text.is_empty() {
            return None;
        }
        let record = self.record()?;
        let attr_text: &str = attr.as_ref();
        if attr_text == "id" {
            return Some(record.id.clone());
        }
        if attr_text == "class" {
            return Some(record.classes.join(" "));
        }
        let engine = current_engine()?;
        let callback = unsafe { (&*engine).inner.callbacks.read_attr? };
        let mut value = super::StyloSlice::default();
        let status = unsafe {
            callback(
                (&*engine).inner.callbacks.ctx,
                self.node.node_id as usize as *const std::ffi::c_void,
                super::StyloSlice {
                    ptr: attr_text.as_ptr(),
                    len: attr_text.len(),
                },
                super::StyloSlice {
                    ptr: namespace.0.as_ptr(),
                    len: namespace.0.len(),
                },
                &mut value,
            )
        };
        if status != super::StyloStatus::Ok {
            return None;
        }
        slice_string(value)
    }

    fn get_tree_counting_result(
        &self,
        _caches: &mut TreeCountingCaches,
    ) -> style::values::computed::TreeCountingResult {
        style::values::computed::TreeCountingResult::new(0, 0)
    }
}
