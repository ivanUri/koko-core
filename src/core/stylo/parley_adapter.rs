//! Parley-facing text layout boundary for Koko.
//!
//! This module deliberately contains no replacement text engine.  The
//! `ParleyBackend` implementation is the only component allowed to discover
//! fonts, select fallback faces, analyse Unicode/BiDi runs, shape glyphs, and
//! break lines.  Koko owns the adapter and cache; Parley owns the text
//! algorithms and the font data.  That separation keeps the Rust/Zig ABI
//! narrow and prevents a second DOM or a fabricated geometry path from being
//! introduced while the Parley dependency is wired into the Rust crate.
//!
//! The intended production backend is a small wrapper around Parley's
//! `FontContext`/`LayoutContext` (and its Fontique/HarfRust/ICU4X stack).  It
//! should translate Parley's owned layout output into the value types below.
//! The adapter never estimates a missing glyph advance: an unavailable or
//! incomplete backend result is an error.
//!
//! Required manifest wiring (intentionally not performed here): add the
//! repository-approved Parley revision and its feature set to
//! `src/core/stylo/Cargo.toml`, update `Cargo.lock`, and declare this module
//! from `lib.rs`.  The backend can then be implemented in a separate file or
//! in the crate integration layer without changing this cache/API boundary.

use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::fmt;
use std::hash::{Hash, Hasher};

/// A finite non-negative CSS pixel value.
///
/// Keeping floating-point values behind this type gives cache keys stable
/// equality/hash semantics and rejects values that cannot represent a real
/// layout constraint.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
pub struct Scalar(f32);

impl Scalar {
    pub fn new(value: f32) -> Result<Self, AdapterErrorKind> {
        if !value.is_finite() || value < 0.0 {
            return Err(AdapterErrorKind::InvalidScalar);
        }
        Ok(Self(value))
    }

    pub const fn zero() -> Self {
        Self(0.0)
    }

    pub const fn get(self) -> f32 {
        self.0
    }
}

impl Eq for Scalar {}

impl Hash for Scalar {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.to_bits().hash(state);
    }
}

/// CSS `font-style` values relevant to shaping and fallback.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum FontStyle {
    Normal,
    Italic,
    Oblique,
}

/// CSS font weight, kept as the numeric value Parley uses for matching.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct FontWeight(u16);

impl FontWeight {
    pub const THIN: Self = Self(100);
    pub const NORMAL: Self = Self(400);
    pub const BOLD: Self = Self(700);
    pub const BLACK: Self = Self(900);

    pub const fn new(value: u16) -> Self {
        Self(if value < 1 {
            1
        } else if value > 1000 {
            1000
        } else {
            value
        })
    }

    pub const fn get(self) -> u16 {
        self.0
    }
}

/// CSS `font-stretch` as a percentage-like matching value.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct FontStretch(u16);

impl FontStretch {
    pub const NORMAL: Self = Self(100);

    pub const fn new(percent: u16) -> Self {
        Self(if percent < 50 {
            50
        } else if percent > 200 {
            200
        } else {
            percent
        })
    }

    pub const fn percent(self) -> u16 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TextDirection {
    Auto,
    Ltr,
    Rtl,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum WhiteSpaceMode {
    Normal,
    Pre,
    PreWrap,
    PreLine,
    BreakSpaces,
}

impl WhiteSpaceMode {
    pub const fn preserves_newlines(self) -> bool {
        matches!(self, Self::Pre | Self::PreWrap | Self::BreakSpaces)
    }

    pub const fn collapses_spaces(self) -> bool {
        matches!(self, Self::Normal | Self::PreLine)
    }

    pub const fn allows_wrapping(self) -> bool {
        !matches!(self, Self::Pre)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LineHeight {
    Normal,
    Absolute(Scalar),
    Multiplier(Scalar),
}

impl Eq for LineHeight {}

impl Hash for LineHeight {
    fn hash<H: Hasher>(&self, state: &mut H) {
        std::mem::discriminant(self).hash(state);
        match self {
            Self::Normal => {}
            Self::Absolute(value) | Self::Multiplier(value) => value.hash(state),
        }
    }
}

/// All style data that can change shaping, fallback, whitespace, or line
/// geometry.  Keep this value complete: omitting a shaping-affecting field
/// would make the layout cache return stale geometry.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct TextStyle {
    pub font_families: Vec<String>,
    pub font_size: Scalar,
    pub font_weight: FontWeight,
    pub font_style: FontStyle,
    pub font_stretch: FontStretch,
    pub locale: Option<String>,
    pub direction: TextDirection,
    pub white_space: WhiteSpaceMode,
    pub line_height: LineHeight,
    pub letter_spacing: Scalar,
    pub word_spacing: Scalar,
    pub font_features: Vec<String>,
    pub variation_axes: Vec<(String, Scalar)>,
}

impl Default for TextStyle {
    fn default() -> Self {
        Self {
            font_families: vec!["sans-serif".to_owned()],
            font_size: Scalar::new(16.0).expect("16px is finite"),
            font_weight: FontWeight::NORMAL,
            font_style: FontStyle::Normal,
            font_stretch: FontStretch::NORMAL,
            locale: None,
            direction: TextDirection::Auto,
            white_space: WhiteSpaceMode::Normal,
            line_height: LineHeight::Normal,
            letter_spacing: Scalar::zero(),
            word_spacing: Scalar::zero(),
            font_features: Vec::new(),
            variation_axes: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct FontQuery {
    pub families: Vec<String>,
    pub weight: FontWeight,
    pub style: FontStyle,
    pub stretch: FontStretch,
    pub locale: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TextWidthConstraint {
    Definite(u32),
    MinContent,
    MaxContent,
}

impl From<&TextStyle> for FontQuery {
    fn from(style: &TextStyle) -> Self {
        Self {
            families: style.font_families.clone(),
            weight: style.font_weight,
            style: style.font_style,
            stretch: style.font_stretch,
            locale: style.locale.clone(),
        }
    }
}

/// Opaque identity for a font selected by the Parley backend.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct FontId(pub u64);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum FontSource {
    RequestedFamily,
    FamilyFallback,
    GenericFallback,
    LastResort,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct FontMatch {
    pub id: FontId,
    pub family: String,
    pub source: FontSource,
}

/// The result of real font discovery and coverage-based fallback.
///
/// `primary` is the requested family match. `fallback_chain` is ordered and
/// must only contain faces that the backend has checked for relevant Unicode
/// coverage. The adapter does not append a guessed font or synthesize a width.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct FontDiscovery {
    pub primary: Option<FontMatch>,
    pub fallback_chain: Vec<FontMatch>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum UnicodeScript {
    Unknown,
    Latin,
    Cyrillic,
    Greek,
    Arabic,
    Hebrew,
    Han,
    Hiragana,
    Katakana,
    Hangul,
    Devanagari,
    Thai,
    Emoji,
    Common,
}

/// Analysis output produced by Parley's Unicode/ICU pipeline.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AnalysisRun {
    pub byte_start: usize,
    pub byte_end: usize,
    pub script: UnicodeScript,
    pub bidi_level: u8,
    pub font: FontId,
    pub source: FontSource,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct TextAnalysis {
    pub runs: Vec<AnalysisRun>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ShapeRequest {
    pub text: String,
    pub style: TextStyle,
    pub fonts: FontDiscovery,
    pub analysis: TextAnalysis,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Glyph {
    pub glyph_id: u32,
    pub cluster_start: usize,
    pub cluster_end: usize,
    pub advance: Scalar,
    pub offset_x: f32,
    pub offset_y: f32,
    pub font: FontId,
}

impl Eq for Glyph {}

#[derive(Clone, Debug, PartialEq)]
pub struct ShapedRun {
    pub byte_start: usize,
    pub byte_end: usize,
    pub bidi_level: u8,
    pub font: FontId,
    pub glyphs: Vec<Glyph>,
    pub advance: Scalar,
}

impl Eq for ShapedRun {}

#[derive(Clone, Debug, PartialEq)]
pub struct ShapedText {
    pub byte_len: usize,
    pub runs: Vec<ShapedRun>,
}

impl Eq for ShapedText {}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct LineBreakRequest {
    pub max_width: Option<Scalar>,
    pub white_space: WhiteSpaceMode,
    pub direction: TextDirection,
    pub line_height: LineHeight,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LineBox {
    pub byte_start: usize,
    pub byte_end: usize,
    pub advance: Scalar,
    pub ascent: Scalar,
    pub descent: Scalar,
    pub baseline: Scalar,
    pub bidi_visual_run_count: usize,
    pub hard_break: bool,
}

impl Eq for LineBox {}

#[derive(Clone, Debug, PartialEq)]
pub struct LayoutResult {
    pub width: Scalar,
    pub height: Scalar,
    pub lines: Vec<LineBox>,
}

impl Eq for LayoutResult {}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum CacheState {
    Miss,
    Hit,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MeasureResult {
    pub layout: LayoutResult,
    pub cache: CacheState,
}

impl Eq for MeasureResult {}

/// Backend boundary for Parley integration.
///
/// A backend implementation should keep Parley's `FontContext` and
/// `LayoutContext` alive for the lifetime of the adapter.  All methods are
/// synchronous by design: Koko can later batch calls at the C ABI boundary,
/// while this layer remains free of locks and cross-language allocations.
pub trait ParleyBackend {
    type Error: Error + Send + Sync + 'static;

    /// Enumerate the requested family and construct an ordered, coverage-
    /// checked fallback chain for the paragraph's scripts and locale.
    fn discover_fonts(
        &mut self,
        query: &FontQuery,
        text: &str,
    ) -> Result<FontDiscovery, Self::Error>;

    /// Run Unicode segmentation, script detection, and the Unicode BiDi
    /// algorithm. The returned runs must cover every shaped text range.
    fn analyze(
        &mut self,
        text: &str,
        style: &TextStyle,
        fonts: &FontDiscovery,
    ) -> Result<TextAnalysis, Self::Error>;

    /// Shape all analysed runs with the selected fonts, including OpenType
    /// substitutions, cluster mapping, RTL ordering, and real advances.
    fn shape(&mut self, request: &ShapeRequest) -> Result<ShapedText, Self::Error>;

    /// Apply Unicode line breaking and whitespace policy to shaped output.
    /// The returned dimensions must come from the backend's real font metrics
    /// and line layout; implementations must not use character-count guesses.
    fn break_lines(
        &mut self,
        text: &str,
        style: &TextStyle,
        request: &LineBreakRequest,
        shaped: &ShapedText,
    ) -> Result<LayoutResult, Self::Error>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdapterErrorKind {
    InvalidScalar,
    InvalidWidth,
    InvalidLayout,
    Backend,
}

#[derive(Debug)]
pub struct AdapterError<E> {
    pub kind: AdapterErrorKind,
    pub message: String,
    pub backend: Option<E>,
}

impl<E> AdapterError<E> {
    fn invalid(kind: AdapterErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            backend: None,
        }
    }

    fn backend(error: E) -> Self
    where
        E: fmt::Display,
    {
        Self {
            kind: AdapterErrorKind::Backend,
            message: error.to_string(),
            backend: Some(error),
        }
    }
}

impl<E: fmt::Display + fmt::Debug> fmt::Display for AdapterError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl<E: fmt::Display + fmt::Debug + Send + Sync + 'static> Error for AdapterError<E> {}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct MeasureKey {
    text: String,
    style: TextStyle,
    max_width: Option<Scalar>,
}

struct LayoutCache {
    capacity: usize,
    entries: HashMap<MeasureKey, LayoutResult>,
    lru: VecDeque<MeasureKey>,
}

impl LayoutCache {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: HashMap::new(),
            lru: VecDeque::new(),
        }
    }

    fn get(&mut self, key: &MeasureKey) -> Option<LayoutResult> {
        let value = self.entries.get(key)?.clone();
        self.touch(key);
        Some(value)
    }

    fn insert(&mut self, key: MeasureKey, value: LayoutResult) {
        if self.capacity == 0 {
            return;
        }
        self.entries.insert(key.clone(), value);
        self.touch(&key);
        while self.entries.len() > self.capacity {
            let Some(oldest) = self.lru.pop_front() else {
                break;
            };
            if self.lru.iter().any(|candidate| candidate == &oldest) {
                continue;
            }
            self.entries.remove(&oldest);
        }
    }

    fn touch(&mut self, key: &MeasureKey) {
        self.lru.retain(|candidate| candidate != key);
        self.lru.push_back(key.clone());
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.lru.clear();
    }

    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Single-threaded layout adapter.  Sharing it across sessions should happen
/// at a higher layer with one backend/context per session or with an explicit
/// synchronization policy; Parley's contexts are intentionally not hidden
/// behind an implicit lock here.
pub struct ParleyAdapter<B> {
    backend: B,
    cache: LayoutCache,
    generation: u64,
}

impl<B> ParleyAdapter<B> {
    pub fn new(backend: B, cache_capacity: usize) -> Self {
        Self {
            backend,
            cache: LayoutCache::new(cache_capacity),
            generation: 0,
        }
    }

    pub fn backend(&self) -> &B {
        &self.backend
    }

    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Clear all cached layouts after a font database, viewport, or document
    /// lifecycle change. The generation is also exposed for ABI callers that
    /// need to correlate layout results with DOM/style snapshots.
    pub fn invalidate(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.cache.clear();
        self.generation
    }

    pub fn clear_cache(&mut self) {
        self.cache.clear();
    }

    pub fn cache_len(&self) -> usize {
        self.cache.len()
    }
}

impl<B: ParleyBackend> ParleyAdapter<B> {
    pub fn discover_fonts(
        &mut self,
        text: &str,
        style: &TextStyle,
    ) -> Result<FontDiscovery, AdapterError<B::Error>> {
        self.backend
            .discover_fonts(&FontQuery::from(style), text)
            .map_err(AdapterError::backend)
    }

    pub fn analyze(
        &mut self,
        text: &str,
        style: &TextStyle,
    ) -> Result<(FontDiscovery, TextAnalysis), AdapterError<B::Error>> {
        let fonts = self.discover_fonts(text, style)?;
        let analysis = self
            .backend
            .analyze(text, style, &fonts)
            .map_err(AdapterError::backend)?;
        validate_analysis(text, &analysis)
            .map_err(|error| AdapterError::invalid(AdapterErrorKind::InvalidLayout, error))?;
        Ok((fonts, analysis))
    }

    pub fn shape(
        &mut self,
        text: &str,
        style: &TextStyle,
    ) -> Result<ShapedText, AdapterError<B::Error>> {
        let (fonts, analysis) = self.analyze(text, style)?;
        let shaped = self
            .backend
            .shape(&ShapeRequest {
                text: text.to_owned(),
                style: style.clone(),
                fonts,
                analysis,
            })
            .map_err(AdapterError::backend)?;
        validate_shaped_text(text, &shaped)
            .map_err(|error| AdapterError::invalid(AdapterErrorKind::InvalidLayout, error))?;
        Ok(shaped)
    }

    pub fn measure(
        &mut self,
        text: &str,
        style: &TextStyle,
        max_width: Option<Scalar>,
    ) -> Result<MeasureResult, AdapterError<B::Error>> {
        if let Some(width) = max_width {
            if !width.get().is_finite() {
                return Err(AdapterError::invalid(
                    AdapterErrorKind::InvalidWidth,
                    "max_width must be finite",
                ));
            }
        }

        let key = MeasureKey {
            text: text.to_owned(),
            style: style.clone(),
            max_width,
        };
        if let Some(layout) = self.cache.get(&key) {
            return Ok(MeasureResult {
                layout,
                cache: CacheState::Hit,
            });
        }

        let shaped = self.shape(text, style)?;
        let request = LineBreakRequest {
            max_width,
            white_space: style.white_space,
            direction: style.direction,
            line_height: style.line_height,
        };
        let layout = self
            .backend
            .break_lines(text, style, &request, &shaped)
            .map_err(AdapterError::backend)?;
        validate_layout(text, &layout)
            .map_err(|error| AdapterError::invalid(AdapterErrorKind::InvalidLayout, error))?;
        self.cache.insert(key, layout.clone());
        Ok(MeasureResult {
            layout,
            cache: CacheState::Miss,
        })
    }
}

/// Measure one text node with the real Parley shaping and line-breaking
/// pipeline.  The return value is deliberately a plain pair so this adapter
/// remains usable by the layout crate without making the CSS text boundary
/// depend on Taffy's geometry types.
pub fn measure_with_parley(
    font_context: &mut parley::FontContext,
    layout_context: &mut parley::LayoutContext<[u8; 4]>,
    text: &str,
    style: &TextStyle,
    constraint: TextWidthConstraint,
) -> Result<(f32, f32), &'static str> {
    use parley::{
        BaseDirection, FontFamily, FontFeatures, FontStyle as ParleyFontStyle, FontVariations,
        FontWeight as ParleyFontWeight, FontWidth, LineHeight as ParleyLineHeight,
        TextStyle as ParleyTextStyle, TextWrapMode, WhiteSpaceCollapse,
    };

    if !style.font_size.get().is_finite() || style.font_size.get() <= 0.0 {
        return Err("font-size must be finite and positive");
    }
    if let TextWidthConstraint::Definite(width_bits) = constraint {
        let width = f32::from_bits(width_bits);
        if !width.is_finite() || width < 0.0 {
            return Err("available text width must be finite and non-negative");
        }
    }

    let family_source = if style.font_families.is_empty() {
        "sans-serif".to_owned()
    } else {
        style.font_families.join(", ")
    };
    let parley_line_height = match style.line_height {
        LineHeight::Normal => ParleyLineHeight::NORMAL,
        LineHeight::Absolute(value) => ParleyLineHeight::Absolute(value.get()),
        LineHeight::Multiplier(value) => ParleyLineHeight::FontSizeRelative(value.get()),
    };
    let (white_space_collapse, text_wrap_mode) = match style.white_space {
        WhiteSpaceMode::Normal => (WhiteSpaceCollapse::Collapse, TextWrapMode::Wrap),
        WhiteSpaceMode::Pre => (WhiteSpaceCollapse::Preserve, TextWrapMode::NoWrap),
        WhiteSpaceMode::PreWrap => (WhiteSpaceCollapse::Preserve, TextWrapMode::Wrap),
        WhiteSpaceMode::PreLine => (WhiteSpaceCollapse::PreserveBreaks, TextWrapMode::Wrap),
        WhiteSpaceMode::BreakSpaces => (WhiteSpaceCollapse::BreakSpaces, TextWrapMode::Wrap),
    };
    let base_direction = match style.direction {
        TextDirection::Auto => BaseDirection::Auto,
        TextDirection::Ltr => BaseDirection::Ltr,
        TextDirection::Rtl => BaseDirection::Rtl,
    };
    let font_features = if style.font_features.is_empty() {
        FontFeatures::empty()
    } else {
        FontFeatures::Source(Cow::Owned(style.font_features.join(", ")))
    };
    let font_variations = if style.variation_axes.is_empty() {
        FontVariations::empty()
    } else {
        let source = style
            .variation_axes
            .iter()
            .map(|(axis, value)| format!("\"{axis}\" {}", value.get()))
            .collect::<Vec<_>>()
            .join(", ");
        FontVariations::Source(Cow::Owned(source))
    };
    let root_style: ParleyTextStyle<'_, '_, [u8; 4]> = ParleyTextStyle {
        font_family: FontFamily::Source(Cow::Owned(family_source)),
        font_size: style.font_size.get(),
        font_width: FontWidth::from_percentage(style.font_stretch.percent() as f32),
        font_style: match style.font_style {
            FontStyle::Normal => ParleyFontStyle::Normal,
            FontStyle::Italic => ParleyFontStyle::Italic,
            FontStyle::Oblique => ParleyFontStyle::Oblique(None),
        },
        font_weight: ParleyFontWeight::new(style.font_weight.get() as f32),
        font_variations,
        font_features,
        line_height: parley_line_height,
        letter_spacing: style.letter_spacing.get(),
        word_spacing: style.word_spacing.get(),
        text_wrap_mode,
        white_space_collapse,
        ..Default::default()
    };
    let mut builder = layout_context.tree_builder(font_context, 1.0, false, &root_style);
    builder.set_base_direction(base_direction);
    builder.push_text(text);
    let (mut layout, _) = builder.build();
    let content_widths = layout.calculate_content_widths();
    let line_width = match constraint {
        TextWidthConstraint::Definite(width_bits) => Some(f32::from_bits(width_bits)),
        TextWidthConstraint::MinContent => Some(content_widths.min),
        TextWidthConstraint::MaxContent => None,
    };
    layout.break_all_lines(line_width);

    let width = layout.full_width();
    let height = layout.height();
    if !width.is_finite() || !height.is_finite() || width < 0.0 || height < 0.0 {
        return Err("Parley returned invalid text metrics");
    }
    Ok((width, height))
}

fn validate_analysis(text: &str, analysis: &TextAnalysis) -> Result<(), &'static str> {
    let mut end = 0;
    for run in &analysis.runs {
        if run.byte_start != end || run.byte_start > run.byte_end || run.byte_end > text.len() {
            return Err("analysis runs must be contiguous UTF-8 byte ranges");
        }
        if !text.is_char_boundary(run.byte_start) || !text.is_char_boundary(run.byte_end) {
            return Err("analysis range must start/end on UTF-8 boundaries");
        }
        end = run.byte_end;
    }
    if end != text.len() {
        return Err("analysis runs must cover the complete text");
    }
    Ok(())
}

fn validate_shaped_text(text: &str, shaped: &ShapedText) -> Result<(), &'static str> {
    if shaped.byte_len != text.len() {
        return Err("shaped text byte length does not match source text");
    }
    for run in &shaped.runs {
        if run.byte_start > run.byte_end
            || run.byte_end > text.len()
            || !text.is_char_boundary(run.byte_start)
            || !text.is_char_boundary(run.byte_end)
        {
            return Err("shaped run has an invalid UTF-8 range");
        }
        for glyph in &run.glyphs {
            if glyph.cluster_start > glyph.cluster_end
                || glyph.cluster_end > text.len()
                || !text.is_char_boundary(glyph.cluster_start)
                || !text.is_char_boundary(glyph.cluster_end)
                || !glyph.advance.get().is_finite()
                || !glyph.offset_x.is_finite()
                || !glyph.offset_y.is_finite()
            {
                return Err("shaped glyph has invalid cluster or metric data");
            }
        }
    }
    Ok(())
}

fn validate_layout(text: &str, layout: &LayoutResult) -> Result<(), &'static str> {
    if !layout.width.get().is_finite() || !layout.height.get().is_finite() {
        return Err("layout dimensions must be finite");
    }
    let mut previous_end = 0;
    for line in &layout.lines {
        if line.byte_start > line.byte_end
            || line.byte_start < previous_end
            || line.byte_end > text.len()
            || !text.is_char_boundary(line.byte_start)
            || !text.is_char_boundary(line.byte_end)
            || !line.advance.get().is_finite()
            || !line.ascent.get().is_finite()
            || !line.descent.get().is_finite()
            || !line.baseline.get().is_finite()
        {
            return Err("layout contains invalid line geometry");
        }
        previous_end = line.byte_end;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_rejects_non_finite_and_negative_values() {
        assert!(Scalar::new(-1.0).is_err());
        assert!(Scalar::new(f32::NAN).is_err());
        assert!(Scalar::new(f32::INFINITY).is_err());
        assert_eq!(Scalar::new(12.5).unwrap().get(), 12.5);
    }

    #[test]
    fn whitespace_policy_is_explicit() {
        assert!(WhiteSpaceMode::Normal.collapses_spaces());
        assert!(!WhiteSpaceMode::Normal.preserves_newlines());
        assert!(WhiteSpaceMode::Pre.preserves_newlines());
        assert!(!WhiteSpaceMode::Pre.allows_wrapping());
        assert!(WhiteSpaceMode::BreakSpaces.allows_wrapping());
    }

    #[test]
    fn style_key_includes_shaping_and_layout_inputs() {
        let mut left = TextStyle::default();
        let mut right = left.clone();
        assert_eq!(left, right);
        left.font_size = Scalar::new(18.0).unwrap();
        assert_ne!(left, right);
        right = left.clone();
        right.direction = TextDirection::Rtl;
        assert_ne!(left, right);
        right = left.clone();
        right
            .variation_axes
            .push(("wght".to_owned(), Scalar::new(700.0).expect("finite axis")));
        assert_ne!(left, right);
    }
}
