//! Single-threaded Stylo stylesheet/cascade-data owner.
//!
//! This module intentionally stops at stylesheet parsing and cascade-data
//! construction. It does not mirror Koko's DOM and does not expose a
//! computed value until the callback-backed `TElement` adapter supplies the
//! required DOM traits. Keeping this state in a separate owner makes that
//! next step explicit and lets the C ABI replace a complete sheet snapshot
//! atomically.

use std::fmt::Debug;
use std::rc::Rc;

use euclid::{Scale, Size2D};
use selectors::matching::QuirksMode;
use servo_arc::Arc;
use style::context::{
    RegisteredSpeculativePainters, SharedStyleContext, StyleContext, StyleSystemOptions,
    ThreadLocalStyleContext,
};
use style::device::servo::{FontMetricsProvider, MediaData};
use style::device::Device;
use style::dom::TNode;
use style::font_metrics::FontMetrics;
use style::media_queries::MediaType;
use style::properties::style_structs::Font;
use style::properties::{ComputedValues, PropertyId, ShorthandId};
use style::queries::values::{
    PrefersColorScheme, PrefersContrast, PrefersReducedMotion, PrefersReducedTransparency,
};
use style::selector_parser::SnapshotMap;
use style::servo::media_features::PointerCapabilities;
use style::shared_lock::{SharedRwLock, StylesheetGuards};
use style::style_resolver::{
    PseudoElementResolution, ResolvedElementStyles, StyleResolverForElement,
};
use style::stylesheets::{DocumentStyleSheet, Origin, Stylesheet, UrlExtraData};
use style::stylist::{RuleInclusion, Stylist};
use style::values::computed::{CSSPixelLength, Length};
use style::values::resolved::Context as ResolvedValueContext;
use style::Atom;
use style_traits::{CSSPixel, DevicePixel};

use super::{
    dom_adapter::{EngineScope, KokoElement},
    StyloEngine, StyloStatus, StyloStylesheetInput, StyloStylesheetOrigin,
};

struct NoopSpeculativePainters;

impl RegisteredSpeculativePainters for NoopSpeculativePainters {
    fn get(&self, _name: &Atom) -> Option<&dyn style::context::RegisteredSpeculativePainter> {
        None
    }
}

static NOOP_SPECULATIVE_PAINTERS: NoopSpeculativePainters = NoopSpeculativePainters;

#[derive(Debug, Default)]
struct NullFontMetricsProvider;

impl FontMetricsProvider for NullFontMetricsProvider {
    fn query_font_metrics(
        &self,
        _vertical: bool,
        _font: &Font,
        _base_size: CSSPixelLength,
        _flags: style::values::specified::font::QueryFontMetricsFlags,
    ) -> FontMetrics {
        FontMetrics::default()
    }

    fn base_size_for_generic(
        &self,
        _generic: style::values::computed::font::GenericFontFamily,
    ) -> Length {
        Length::new(16.0)
    }
}

#[derive(Clone)]
struct RetainedSheet {
    sheet_id: u64,
    sheet: DocumentStyleSheet,
}

pub(crate) struct StylistStore {
    lock: Rc<SharedRwLock>,
    stylist: Stylist,
    sheets: Vec<RetainedSheet>,
    url_data: UrlExtraData,
    generation: u64,
}

impl StylistStore {
    pub(crate) fn new(frame_id: u64, lock: Rc<SharedRwLock>) -> Self {
        let defaults = ComputedValues::initial_values_with_font_override(Font::initial_values());
        let media = MediaData {
            media_type: MediaType::screen(),
            viewport_size: Size2D::<f32, CSSPixel>::new(1280.0, 720.0),
            device_size: Size2D::<f32, DevicePixel>::new(1280.0, 720.0),
            device_pixel_ratio: Scale::<f32, CSSPixel, DevicePixel>::new(1.0),
            quirks_mode: QuirksMode::NoQuirks,
            prefers_color_scheme: PrefersColorScheme::Light,
            prefers_contrast: PrefersContrast::NoPreference,
            prefers_reduced_motion: PrefersReducedMotion::NoPreference,
            prefers_reduced_transparency: PrefersReducedTransparency::NoPreference,
            primary_pointer_capabilities: PointerCapabilities::default(),
            all_pointer_capabilities: PointerCapabilities::default(),
        };
        let device = Device::new(
            defaults,
            Box::new(NullFontMetricsProvider),
            String::new().into_boxed_str(),
            (frame_id, !frame_id),
            media,
        );
        let stylist = Stylist::new(device, QuirksMode::NoQuirks);
        Self {
            lock,
            stylist,
            sheets: Vec::new(),
            url_data: UrlExtraData::from(
                url::Url::parse("about:blank")
                    .expect("the static about:blank URL must always be valid"),
            ),
            generation: 0,
        }
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn author_cascade_data(&self) -> &style::stylist::CascadeData {
        self.stylist
            .cascade_data()
            .borrow_for_origin(Origin::Author)
    }

    pub(crate) fn stylesheet_count(&self) -> usize {
        self.sheets.len()
    }

    pub(crate) fn rule_count(&self, sheet_id: u64) -> usize {
        let Some(retained) = self.sheets.iter().find(|sheet| sheet.sheet_id == sheet_id) else {
            return 0;
        };
        let guard = self.lock.read();
        retained
            .sheet
            .0
            .contents
            .read_with(&guard)
            .rules(&guard)
            .len()
    }

    pub(crate) fn selector_count(&self) -> usize {
        self.stylist.num_selectors()
    }

    pub(crate) fn declaration_count(&self) -> usize {
        self.stylist.num_declarations()
    }

    pub(crate) fn resolve_element(
        &self,
        engine: *mut StyloEngine,
        element: KokoElement,
        parent_style: Option<&ComputedValues>,
        layout_parent_style: Option<&ComputedValues>,
    ) -> ResolvedElementStyles {
        let _engine_scope = EngineScope::enter(engine);
        let added_layout_state =
            !style::thread_state::get().contains(style::thread_state::ThreadState::LAYOUT);
        if added_layout_state {
            style::thread_state::enter(style::thread_state::ThreadState::LAYOUT);
        }
        let result = {
            let guard = self.lock.read();
            let guards = StylesheetGuards::same(&guard);
            let snapshots = SnapshotMap::new();
            let shared = SharedStyleContext {
                stylist: &self.stylist,
                visited_styles_enabled: false,
                options: StyleSystemOptions::default(),
                guards,
                current_time_for_animations: 0.0,
                traversal_flags: style::traversal_flags::TraversalFlags::empty(),
                snapshot_map: &snapshots,
                animations: style::servo::animation::DocumentAnimationSet::default(),
                registered_speculative_painters: &NOOP_SPECULATIVE_PAINTERS,
            };
            let mut thread_local = ThreadLocalStyleContext::<KokoElement>::new();
            thread_local.current_dom_depth = element.as_node().depth();
            // Targeted CSSOM resolution runs outside Stylo's normal
            // traversal, so construct the ancestor bloom filter explicitly.
            // Without this, descendant and child selectors are rejected by
            // the fast path before the callback-backed matcher is reached.
            thread_local.bloom_filter.rebuild(element);
            let mut context = StyleContext {
                shared: &shared,
                thread_local: &mut thread_local,
            };
            StyleResolverForElement::new(
                element,
                &mut context,
                RuleInclusion::All,
                PseudoElementResolution::Force,
            )
            .resolve_style(parent_style, layout_parent_style)
        };
        if added_layout_state {
            style::thread_state::exit(style::thread_state::ThreadState::LAYOUT);
        }
        result
    }

    pub(crate) fn serialize_computed_property(
        &self,
        style: &ComputedValues,
        property: &PropertyId,
    ) -> Result<String, StyloStatus> {
        let shorthand = match property.as_shorthand() {
            Err(declaration) => return Ok(style.computed_value_to_string(declaration)),
            Ok(shorthand) => shorthand,
        };
        // Other shorthands still follow the embedder's existing fallback path.
        match shorthand {
            ShorthandId::GridArea
            | ShorthandId::GridColumn
            | ShorthandId::GridRow
            | ShorthandId::GridTemplate
            | ShorthandId::Gap
            | ShorthandId::TextWrap
            | ShorthandId::WhiteSpace => {}
            _ => return Err(StyloStatus::Unsupported),
        }

        // `gap` is a pair of independent longhands.  Stylo's resolved-value
        // context treats the shorthand itself as the current property and can
        // therefore expose the initial `normal` value even when one of the
        // longhands was authored explicitly.  Serialize the cascaded
        // longhands directly so CSSOM and the layout bridge see the authored
        // computed pair.
        if shorthand == ShorthandId::Gap {
            let values: Vec<_> = shorthand
                .longhands()
                .map(|id| {
                    style.computed_value_to_string(
                        style::properties::PropertyDeclarationId::Longhand(id),
                    )
                })
                .collect();
            return Ok(match values.as_slice() {
                [first, second] if first == second => first.clone(),
                [first, second] => format!("{first} {second}"),
                _ => String::new(),
            });
        }

        // Build the shorthand from the cascaded longhands, including values
        // inherited from a parent or set by separate declarations.
        let mut context = ResolvedValueContext {
            style,
            for_property: property.clone(),
            current_longhand: None,
        };
        let declarations: Vec<_> = shorthand
            .longhands()
            .map(|id| style.computed_or_resolved_declaration(id, Some(&mut context)))
            .collect();
        let declarations: Vec<_> = declarations.iter().collect();
        let mut serialized = String::new();
        shorthand
            .longhands_to_css(&declarations, &mut serialized)
            .map_err(|_| StyloStatus::Unsupported)?;
        Ok(serialized)
    }

    pub(crate) fn replace(&mut self, inputs: &[StyloStylesheetInput]) -> Result<(), StyloStatus> {
        if inputs.len() > 65_536 {
            return Err(StyloStatus::InvalidArgument);
        }

        let parsed = self.parse_batch(inputs)?;
        let guard = self.lock.read();
        let old = std::mem::take(&mut self.sheets);
        for retained in old {
            self.stylist.remove_stylesheet(retained.sheet, &guard);
        }
        for retained in &parsed {
            self.stylist
                .append_stylesheet(retained.sheet.clone(), &guard);
        }
        let guards = StylesheetGuards::same(&guard);
        self.stylist.flush(&guards);
        self.sheets = parsed;
        self.generation = self.generation.wrapping_add(1);
        Ok(())
    }

    pub(crate) fn flush(&mut self) {
        let guard = self.lock.read();
        let guards = StylesheetGuards::same(&guard);
        self.stylist.flush(&guards);
    }

    fn parse_batch(
        &self,
        inputs: &[StyloStylesheetInput],
    ) -> Result<Vec<RetainedSheet>, StyloStatus> {
        let mut parsed = Vec::with_capacity(inputs.len());
        for input in inputs {
            if input.sheet_id == 0
                || parsed
                    .iter()
                    .any(|sheet: &RetainedSheet| sheet.sheet_id == input.sheet_id)
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
                Arc::new(self.lock.wrap(style::media_queries::MediaList::empty())),
                self.lock.as_ref().clone(),
                None,
                None,
                QuirksMode::NoQuirks,
            );
            if input.enabled == 0 {
                sheet.set_disabled(true);
            }
            parsed.push(RetainedSheet {
                sheet_id: input.sheet_id,
                sheet: DocumentStyleSheet(Arc::new(sheet)),
            });
        }
        Ok(parsed)
    }
}
