//! Rust-owned layout session for Koko.
//!
//! The first boundary is deliberately small: Zig owns the document and calls
//! this crate with stable node handles. Rust owns only the Taffy layout tree
//! and Parley font/text contexts. No DOM mirror is created here.

// These are the existing Koko Rust bridges. The build script generates only a
// namespaced source view of them, so html5ever, Stylo, Taffy, and Parley are
// emitted into one Rust link unit without copying or editing their sources.
// The authoritative DOM remains in Zig; these modules only expose their
// existing callback-based bridge APIs.
mod html5ever_bridge {
    include!(concat!(env!("OUT_DIR"), "/html5ever_bridge.rs"));
}
mod stylo_bridge {
    include!(concat!(env!("OUT_DIR"), "/stylo_bridge.rs"));
}
#[path = "../stylo/parley_adapter.rs"]
mod parley_adapter;
#[path = "../stylo/taffy_mapping.rs"]
mod taffy_mapping;

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

use parley::{FontContext, LayoutContext};
use taffy::prelude::{
    auto, fr, length, max_content, min_content, percent, AlignContent, AlignItems, BoxSizing,
    Dimension, Display, FlexDirection, FlexWrap, LengthPercentage, LengthPercentageAuto, Position,
    Style,
};
use taffy::{AvailableSpace, GridAutoFlow, NodeId, Overflow, Size, TaffyTree, TrackSizingFunction};

#[repr(i32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KokoLayoutStatus {
    Ok = 0,
    InvalidArgument = 1,
    InvalidHandle = 2,
    NotReady = 3,
    InternalError = 4,
    Panic = 5,
    Unsupported = 6,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct KokoLayoutGeometry {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub border_left: f32,
    pub border_right: f32,
    pub border_top: f32,
    pub border_bottom: f32,
    pub padding_left: f32,
    pub padding_right: f32,
    pub padding_top: f32,
    pub padding_bottom: f32,
    pub margin_left: f32,
    pub margin_right: f32,
    pub margin_top: f32,
    pub margin_bottom: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct KokoLayoutProperty {
    pub name: *const u8,
    pub name_len: usize,
    pub value: *const u8,
    pub value_len: usize,
}

struct PropertySnapshot {
    values: HashMap<String, String>,
}

impl taffy_mapping::ComputedStyleSource for PropertySnapshot {
    fn computed_property(&self, property: &str) -> Option<String> {
        let value = self.values.get(property)?;
        match (property, value.as_str()) {
            // The used value of a normal flex/grid gap is zero.
            ("row-gap" | "column-gap", "normal") => Some("0px".into()),
            // Stylo serializes dense row flow as just "dense".
            ("grid-auto-flow", "dense") => Some("row dense".into()),
            _ => Some(value.clone()),
        }
    }
}

struct LayoutNodeContext {
    text: Option<String>,
    text_style: parley_adapter::TextStyle,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct TextMeasureCacheKey {
    text: String,
    style: parley_adapter::TextStyle,
    constraint: parley_adapter::TextWidthConstraint,
}

impl Default for LayoutNodeContext {
    fn default() -> Self {
        Self {
            text: None,
            text_style: parley_adapter::TextStyle::default(),
        }
    }
}

fn parse_non_negative_px(value: &str) -> Option<f32> {
    let value = value.trim();
    let number = value.strip_suffix("px").unwrap_or(value).trim();
    let parsed = number.parse::<f32>().ok()?;
    (parsed.is_finite() && parsed >= 0.0).then_some(parsed)
}

fn text_style_from_snapshot(snapshot: &PropertySnapshot) -> parley_adapter::TextStyle {
    let mut style = parley_adapter::TextStyle::default();
    if let Some(value) = snapshot.values.get("font-size") {
        if let Some(value) = parse_non_negative_px(&value) {
            if let Ok(value) = parley_adapter::Scalar::new(value) {
                style.font_size = value;
            }
        }
    }
    if let Some(value) = snapshot.values.get("font-family") {
        let families = value
            .split(',')
            .map(str::trim)
            .map(|family| family.trim_matches(['\'', '"']))
            .filter(|family| !family.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if !families.is_empty() {
            style.font_families = families;
        }
    }
    if let Some(value) = snapshot.values.get("font-weight") {
        if let Ok(weight) = value.trim().parse::<u16>() {
            style.font_weight = parley_adapter::FontWeight::new(weight);
        } else if value.trim().eq_ignore_ascii_case("bold") {
            style.font_weight = parley_adapter::FontWeight::BOLD;
        }
    }
    if let Some(value) = snapshot.values.get("font-style") {
        style.font_style = match value.trim().to_ascii_lowercase().as_str() {
            "italic" => parley_adapter::FontStyle::Italic,
            "oblique" => parley_adapter::FontStyle::Oblique,
            _ => parley_adapter::FontStyle::Normal,
        };
    }
    if let Some(value) = snapshot.values.get("line-height") {
        let value = value.trim();
        if value.eq_ignore_ascii_case("normal") {
            style.line_height = parley_adapter::LineHeight::Normal;
        } else if let Some(value) = parse_non_negative_px(value) {
            if let Ok(value) = parley_adapter::Scalar::new(value) {
                style.line_height = parley_adapter::LineHeight::Absolute(value);
            }
        }
    }
    if let Some(value) = snapshot.values.get("direction") {
        style.direction = match value.trim().to_ascii_lowercase().as_str() {
            "ltr" => parley_adapter::TextDirection::Ltr,
            "rtl" => parley_adapter::TextDirection::Rtl,
            _ => parley_adapter::TextDirection::Auto,
        };
    }
    if let Some(value) = snapshot.values.get("white-space") {
        style.white_space = match value.trim().to_ascii_lowercase().as_str() {
            "pre" => parley_adapter::WhiteSpaceMode::Pre,
            "pre-wrap" => parley_adapter::WhiteSpaceMode::PreWrap,
            "pre-line" => parley_adapter::WhiteSpaceMode::PreLine,
            "break-spaces" => parley_adapter::WhiteSpaceMode::BreakSpaces,
            _ => parley_adapter::WhiteSpaceMode::Normal,
        };
    }
    style
}

const TEXT_STYLE_PROPERTIES: &[&str] = &[
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "direction",
    "white-space",
];

/// Applies only properties that affect Parley text shaping/line breaking.
/// This is separate from the full computed-style ABI so a text leaf can
/// update inherited text state without resending box geometry properties.
fn apply_text_style_snapshot(
    style: &mut parley_adapter::TextStyle,
    snapshot: &PropertySnapshot,
) -> Result<(), KokoLayoutStatus> {
    if snapshot
        .values
        .keys()
        .any(|name| !TEXT_STYLE_PROPERTIES.contains(&name.as_str()))
    {
        return Err(KokoLayoutStatus::InvalidArgument);
    }

    for (name, value) in &snapshot.values {
        match name.as_str() {
            "font-family" => {
                let families = value
                    .split(',')
                    .map(str::trim)
                    .map(|family| family.trim_matches(['\'', '"']))
                    .filter(|family| !family.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                if families.is_empty() {
                    return Err(KokoLayoutStatus::InvalidArgument);
                }
                style.font_families = families;
            }
            "font-size" => {
                let value =
                    parse_non_negative_px(value).ok_or(KokoLayoutStatus::InvalidArgument)?;
                style.font_size = parley_adapter::Scalar::new(value)
                    .map_err(|_| KokoLayoutStatus::InvalidArgument)?;
            }
            "font-weight" => {
                style.font_weight = if value.trim().eq_ignore_ascii_case("normal") {
                    parley_adapter::FontWeight::NORMAL
                } else if value.trim().eq_ignore_ascii_case("bold") {
                    parley_adapter::FontWeight::BOLD
                } else {
                    let value = value
                        .trim()
                        .parse::<u16>()
                        .map_err(|_| KokoLayoutStatus::InvalidArgument)?;
                    parley_adapter::FontWeight::new(value)
                };
            }
            "font-style" => {
                style.font_style = match value.trim().to_ascii_lowercase().as_str() {
                    "normal" => parley_adapter::FontStyle::Normal,
                    "italic" => parley_adapter::FontStyle::Italic,
                    "oblique" => parley_adapter::FontStyle::Oblique,
                    _ => return Err(KokoLayoutStatus::InvalidArgument),
                };
            }
            "line-height" => {
                let value = value.trim();
                style.line_height = if value.eq_ignore_ascii_case("normal") {
                    parley_adapter::LineHeight::Normal
                } else if let Some(value) = value.strip_suffix("px") {
                    let value = value
                        .trim()
                        .parse::<f32>()
                        .map_err(|_| KokoLayoutStatus::InvalidArgument)?;
                    parley_adapter::LineHeight::Absolute(
                        parley_adapter::Scalar::new(value)
                            .map_err(|_| KokoLayoutStatus::InvalidArgument)?,
                    )
                } else {
                    let value = value
                        .parse::<f32>()
                        .map_err(|_| KokoLayoutStatus::InvalidArgument)?;
                    parley_adapter::LineHeight::Multiplier(
                        parley_adapter::Scalar::new(value)
                            .map_err(|_| KokoLayoutStatus::InvalidArgument)?,
                    )
                };
            }
            "direction" => {
                style.direction = match value.trim().to_ascii_lowercase().as_str() {
                    "ltr" => parley_adapter::TextDirection::Ltr,
                    "rtl" => parley_adapter::TextDirection::Rtl,
                    _ => return Err(KokoLayoutStatus::InvalidArgument),
                };
            }
            "white-space" => {
                style.white_space = match value.trim().to_ascii_lowercase().as_str() {
                    "normal" => parley_adapter::WhiteSpaceMode::Normal,
                    "pre" => parley_adapter::WhiteSpaceMode::Pre,
                    "pre-wrap" => parley_adapter::WhiteSpaceMode::PreWrap,
                    "pre-line" => parley_adapter::WhiteSpaceMode::PreLine,
                    "break-spaces" => parley_adapter::WhiteSpaceMode::BreakSpaces,
                    _ => return Err(KokoLayoutStatus::InvalidArgument),
                };
            }
            _ => unreachable!("validated by TEXT_STYLE_PROPERTIES"),
        }
    }

    Ok(())
}

#[repr(C)]
pub struct LayoutSession {
    tree: TaffyTree<LayoutNodeContext>,
    // These contexts are session-owned so text measurement can be added later
    // without changing the Zig ABI or introducing global mutable state.
    #[allow(dead_code)]
    font_context: FontContext,
    #[allow(dead_code)]
    text_layout_context: LayoutContext,
    text_measure_cache: HashMap<TextMeasureCacheKey, (f32, f32)>,
    handles: HashMap<u64, NodeId>,
    next_handle: u64,
    batch_depth: u32,
    layout_ready: bool,
    layout_computations: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct KokoLayoutMetrics {
    pub layout_computations: u64,
}

impl LayoutSession {
    fn new() -> Self {
        Self {
            tree: TaffyTree::new(),
            font_context: FontContext::new(),
            text_layout_context: LayoutContext::new(),
            text_measure_cache: HashMap::new(),
            handles: HashMap::new(),
            next_handle: 1,
            batch_depth: 0,
            layout_ready: false,
            layout_computations: 0,
        }
    }

    fn invalidate(&mut self) {
        self.layout_ready = false;
    }

    fn node(&self, handle: u64) -> Result<NodeId, KokoLayoutStatus> {
        self.handles
            .get(&handle)
            .copied()
            .ok_or(KokoLayoutStatus::InvalidHandle)
    }

    fn allocate_handle(&mut self, node: NodeId) -> Result<u64, KokoLayoutStatus> {
        let handle = self.next_handle;
        self.next_handle = self
            .next_handle
            .checked_add(1)
            .ok_or(KokoLayoutStatus::InternalError)?;
        self.handles.insert(handle, node);
        Ok(handle)
    }
}

fn status<F>(operation: F) -> KokoLayoutStatus
where
    F: FnOnce() -> KokoLayoutStatus,
{
    catch_unwind(AssertUnwindSafe(operation)).unwrap_or(KokoLayoutStatus::Panic)
}

fn valid_dimension(value: f32) -> bool {
    value.is_finite() && value >= 0.0
}

fn mapping_status(error: taffy_mapping::MappingError) -> KokoLayoutStatus {
    match error {
        taffy_mapping::MappingError::UnsupportedValue { .. } => KokoLayoutStatus::Unsupported,
        _ => KokoLayoutStatus::InvalidArgument,
    }
}

fn to_dimension(value: taffy_mapping::Length) -> Result<Dimension, KokoLayoutStatus> {
    match value {
        taffy_mapping::Length::Px(value) => Ok(length(value)),
        taffy_mapping::Length::Percent(value) => Ok(percent(value)),
        taffy_mapping::Length::Auto => Ok(auto()),
        taffy_mapping::Length::MinContent | taffy_mapping::Length::MaxContent => {
            Err(KokoLayoutStatus::Unsupported)
        }
        taffy_mapping::Length::FitContent => Err(KokoLayoutStatus::Unsupported),
        taffy_mapping::Length::None => Err(KokoLayoutStatus::Unsupported),
    }
}

fn to_length_percentage(
    value: taffy_mapping::Length,
) -> Result<LengthPercentage, KokoLayoutStatus> {
    match value {
        taffy_mapping::Length::Px(value) => Ok(length(value)),
        taffy_mapping::Length::Percent(value) => Ok(percent(value)),
        _ => Err(KokoLayoutStatus::Unsupported),
    }
}

fn to_length_percentage_auto(
    value: taffy_mapping::Length,
) -> Result<LengthPercentageAuto, KokoLayoutStatus> {
    match value {
        taffy_mapping::Length::Px(value) => Ok(length(value)),
        taffy_mapping::Length::Percent(value) => Ok(percent(value)),
        taffy_mapping::Length::Auto | taffy_mapping::Length::None => Ok(auto()),
        _ => Err(KokoLayoutStatus::Unsupported),
    }
}

fn to_rect_auto(
    edges: taffy_mapping::Edges<taffy_mapping::Length>,
) -> Result<taffy::Rect<LengthPercentageAuto>, KokoLayoutStatus> {
    Ok(taffy::Rect {
        top: to_length_percentage_auto(edges.top)?,
        right: to_length_percentage_auto(edges.right)?,
        bottom: to_length_percentage_auto(edges.bottom)?,
        left: to_length_percentage_auto(edges.left)?,
    })
}

fn to_rect(
    edges: taffy_mapping::Edges<taffy_mapping::Length>,
) -> Result<taffy::Rect<LengthPercentage>, KokoLayoutStatus> {
    Ok(taffy::Rect {
        top: to_length_percentage(edges.top)?,
        right: to_length_percentage(edges.right)?,
        bottom: to_length_percentage(edges.bottom)?,
        left: to_length_percentage(edges.left)?,
    })
}

fn to_align_items(value: taffy_mapping::Align) -> AlignItems {
    match value {
        taffy_mapping::Align::Start => AlignItems::START,
        taffy_mapping::Align::End => AlignItems::END,
        taffy_mapping::Align::FlexStart => AlignItems::FLEX_START,
        taffy_mapping::Align::FlexEnd => AlignItems::FLEX_END,
        taffy_mapping::Align::Center => AlignItems::CENTER,
        taffy_mapping::Align::Stretch => AlignItems::STRETCH,
        taffy_mapping::Align::Auto | taffy_mapping::Align::Normal => AlignItems::NORMAL,
        taffy_mapping::Align::Baseline => AlignItems::BASELINE,
        taffy_mapping::Align::SpaceBetween
        | taffy_mapping::Align::SpaceAround
        | taffy_mapping::Align::SpaceEvenly => AlignItems::NORMAL,
    }
}

fn to_align_content(value: taffy_mapping::Align) -> AlignContent {
    match value {
        taffy_mapping::Align::Start => AlignContent::START,
        taffy_mapping::Align::End => AlignContent::END,
        taffy_mapping::Align::FlexStart => AlignContent::FLEX_START,
        taffy_mapping::Align::FlexEnd => AlignContent::FLEX_END,
        taffy_mapping::Align::Center => AlignContent::CENTER,
        taffy_mapping::Align::Stretch => AlignContent::STRETCH,
        taffy_mapping::Align::Auto | taffy_mapping::Align::Normal => AlignContent::NORMAL,
        taffy_mapping::Align::SpaceBetween => AlignContent::SPACE_BETWEEN,
        taffy_mapping::Align::SpaceAround => AlignContent::SPACE_AROUND,
        taffy_mapping::Align::SpaceEvenly => AlignContent::SPACE_EVENLY,
        taffy_mapping::Align::Baseline => AlignContent::NORMAL,
    }
}

fn to_taffy_style(mapped: taffy_mapping::LayoutStyle) -> Result<Style, KokoLayoutStatus> {
    let mut style = Style::default();
    style.display = match mapped.display {
        taffy_mapping::Display::None => Display::None,
        taffy_mapping::Display::Block | taffy_mapping::Display::FlowRoot => Display::Block,
        taffy_mapping::Display::Flex | taffy_mapping::Display::InlineFlex => Display::Flex,
        taffy_mapping::Display::Grid | taffy_mapping::Display::InlineGrid => Display::Grid,
        taffy_mapping::Display::Contents
        | taffy_mapping::Display::Inline
        | taffy_mapping::Display::Table
        | taffy_mapping::Display::InlineTable
        | taffy_mapping::Display::ListItem => return Err(KokoLayoutStatus::Unsupported),
    };
    style.box_sizing = match mapped.box_sizing {
        taffy_mapping::BoxSizing::ContentBox => BoxSizing::ContentBox,
        taffy_mapping::BoxSizing::BorderBox => BoxSizing::BorderBox,
    };
    style.size = Size {
        width: to_dimension(mapped.size.width)?,
        height: to_dimension(mapped.size.height)?,
    };
    style.min_size = Size {
        width: to_length_percentage_auto(mapped.size.min_width)?,
        height: to_length_percentage_auto(mapped.size.min_height)?,
    };
    style.max_size = Size {
        width: to_length_percentage_auto(mapped.size.max_width)?,
        height: to_length_percentage_auto(mapped.size.max_height)?,
    };
    style.margin = to_rect_auto(mapped.margin)?;
    style.padding = to_rect(mapped.padding)?;
    style.border = taffy::Rect {
        top: length(mapped.border.top),
        right: length(mapped.border.right),
        bottom: length(mapped.border.bottom),
        left: length(mapped.border.left),
    };
    style.gap = Size {
        width: to_length_percentage(mapped.flex.column_gap)?,
        height: to_length_percentage(mapped.flex.row_gap)?,
    };
    style.flex_direction = match mapped.flex.direction {
        taffy_mapping::FlexDirection::Row => FlexDirection::Row,
        taffy_mapping::FlexDirection::RowReverse => FlexDirection::RowReverse,
        taffy_mapping::FlexDirection::Column => FlexDirection::Column,
        taffy_mapping::FlexDirection::ColumnReverse => FlexDirection::ColumnReverse,
    };
    style.flex_wrap = match mapped.flex.wrap {
        taffy_mapping::FlexWrap::NoWrap => FlexWrap::NoWrap,
        taffy_mapping::FlexWrap::Wrap => FlexWrap::Wrap,
        taffy_mapping::FlexWrap::WrapReverse => FlexWrap::WrapReverse,
    };
    style.flex_grow = mapped.flex.grow;
    style.flex_shrink = mapped.flex.shrink;
    style.flex_basis = to_dimension(mapped.flex.basis)?;
    style.align_items = to_align_items(mapped.flex.align_items);
    if mapped.flex.align_self != taffy_mapping::Align::Auto {
        style.align_self = Some(to_align_items(mapped.flex.align_self));
    }
    style.align_content = to_align_content(mapped.flex.align_content);
    style.justify_content = match (style.display, mapped.flex.justify_content) {
        (Display::Flex, taffy_mapping::Align::Stretch) => AlignContent::FLEX_START,
        (_, align) => to_align_content(align),
    };
    style.position = match mapped.position.position {
        taffy_mapping::Position::Static => Position::Static,
        taffy_mapping::Position::Relative => Position::Relative,
        taffy_mapping::Position::Absolute => Position::Absolute,
        taffy_mapping::Position::Fixed => Position::Fixed,
        taffy_mapping::Position::Sticky => Position::Sticky,
    };
    style.inset = taffy::Rect {
        top: to_length_percentage_auto(mapped.position.top)?,
        right: to_length_percentage_auto(mapped.position.right)?,
        bottom: to_length_percentage_auto(mapped.position.bottom)?,
        left: to_length_percentage_auto(mapped.position.left)?,
    };
    style.overflow = taffy::Point {
        x: to_overflow(mapped.overflow.x),
        y: to_overflow(mapped.overflow.y),
    };
    if style.display == Display::Grid {
        style.grid_template_columns = to_grid_template(mapped.grid.columns)?;
        style.grid_template_rows = to_grid_template(mapped.grid.rows)?;
        if mapped.grid.auto_columns != taffy_mapping::Length::Auto {
            style
                .grid_auto_columns
                .push(to_implicit_grid_track(mapped.grid.auto_columns)?);
        }
        if mapped.grid.auto_rows != taffy_mapping::Length::Auto {
            style
                .grid_auto_rows
                .push(to_implicit_grid_track(mapped.grid.auto_rows)?);
        }
        style.grid_auto_flow = match mapped.grid.auto_flow {
            taffy_mapping::GridAutoFlow::Row => GridAutoFlow::Row,
            taffy_mapping::GridAutoFlow::Column => GridAutoFlow::Column,
            taffy_mapping::GridAutoFlow::RowDense => GridAutoFlow::RowDense,
            taffy_mapping::GridAutoFlow::ColumnDense => GridAutoFlow::ColumnDense,
        };
    }
    Ok(style)
}

fn to_overflow(value: taffy_mapping::Overflow) -> Overflow {
    match value {
        taffy_mapping::Overflow::Visible => Overflow::Visible,
        taffy_mapping::Overflow::Hidden => Overflow::Hidden,
        taffy_mapping::Overflow::Clip => Overflow::Clip,
        taffy_mapping::Overflow::Scroll | taffy_mapping::Overflow::Auto => Overflow::Scroll,
    }
}

fn to_grid_track(value: taffy_mapping::GridTrack) -> Result<TrackSizingFunction, KokoLayoutStatus> {
    use taffy_mapping::GridTrack;

    match value {
        GridTrack::Px(value) => Ok(length(value)),
        GridTrack::Percent(value) => Ok(percent(value)),
        GridTrack::Flex(value) => Ok(fr(value)),
        GridTrack::Auto => Ok(auto()),
        GridTrack::MinContent => Ok(min_content()),
        GridTrack::MaxContent => Ok(max_content()),
        GridTrack::MinMax(min, max) => {
            if matches!(*min, GridTrack::Flex(_) | GridTrack::MinMax(_, _))
                || matches!(*max, GridTrack::MinMax(_, _))
            {
                return Err(KokoLayoutStatus::Unsupported);
            }
            Ok(taffy::style_helpers::minmax(
                to_grid_track(*min)?.min,
                to_grid_track(*max)?.max,
            ))
        }
        GridTrack::FitContent(_) => Err(KokoLayoutStatus::Unsupported),
    }
}

fn to_grid_template(
    template: taffy_mapping::GridTemplate,
) -> Result<Vec<taffy::GridTemplateComponent<String>>, KokoLayoutStatus> {
    match template {
        taffy_mapping::GridTemplate::None => Ok(Vec::new()),
        taffy_mapping::GridTemplate::Tracks(tracks) => tracks
            .into_iter()
            .map(|track| to_grid_track(track).map(taffy::GridTemplateComponent::Single))
            .collect(),
        taffy_mapping::GridTemplate::Unsupported(_) => Err(KokoLayoutStatus::Unsupported),
    }
}

fn to_implicit_grid_track(
    value: taffy_mapping::Length,
) -> Result<TrackSizingFunction, KokoLayoutStatus> {
    match value {
        taffy_mapping::Length::Px(value) => Ok(length(value)),
        taffy_mapping::Length::Percent(value) => Ok(percent(value)),
        taffy_mapping::Length::Auto => Ok(auto()),
        taffy_mapping::Length::MinContent => Ok(min_content()),
        taffy_mapping::Length::MaxContent => Ok(max_content()),
        _ => Err(KokoLayoutStatus::Unsupported),
    }
}

fn property_snapshot(
    properties: *const KokoLayoutProperty,
    count: usize,
) -> Result<PropertySnapshot, KokoLayoutStatus> {
    if count > 0 && properties.is_null() {
        return Err(KokoLayoutStatus::InvalidArgument);
    }
    let mut values = HashMap::with_capacity(count);
    let properties = if count == 0 {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(properties, count) }
    };
    for property in properties {
        if (property.name_len > 0 && property.name.is_null())
            || (property.value_len > 0 && property.value.is_null())
        {
            return Err(KokoLayoutStatus::InvalidArgument);
        }
        let name = std::str::from_utf8(unsafe {
            std::slice::from_raw_parts(property.name, property.name_len)
        })
        .map_err(|_| KokoLayoutStatus::InvalidArgument)?
        .trim()
        .to_ascii_lowercase();
        let value = std::str::from_utf8(unsafe {
            std::slice::from_raw_parts(property.value, property.value_len)
        })
        .map_err(|_| KokoLayoutStatus::InvalidArgument)?
        .trim()
        .to_owned();
        values.insert(name, value);
    }
    Ok(PropertySnapshot { values })
}

fn geometry(layout: &taffy::Layout) -> KokoLayoutGeometry {
    KokoLayoutGeometry {
        x: layout.location.x,
        y: layout.location.y,
        width: layout.size.width,
        height: layout.size.height,
        border_left: layout.border.left,
        border_right: layout.border.right,
        border_top: layout.border.top,
        border_bottom: layout.border.bottom,
        padding_left: layout.padding.left,
        padding_right: layout.padding.right,
        padding_top: layout.padding.top,
        padding_bottom: layout.padding.bottom,
        margin_left: layout.margin.left,
        margin_right: layout.margin.right,
        margin_top: layout.margin.top,
        margin_bottom: layout.margin.bottom,
    }
}

/// Returns the location of a node in the root coordinate space of its Taffy
/// tree. Taffy's `Layout::location` is parent-relative, so the coordinator
/// must not expose it directly as a document/client rectangle.
///
/// This deliberately accumulates only layout-tree locations. Scroll offsets,
/// transforms, viewport offsets, and iframe coordinate-space conversion remain
/// Zig-side concerns because they depend on Koko's authoritative DOM/window
/// lifecycle.
fn absolute_location(
    tree: &TaffyTree<LayoutNodeContext>,
    node: NodeId,
) -> Result<(f32, f32), KokoLayoutStatus> {
    let mut current = Some(node);
    let mut x = 0.0;
    let mut y = 0.0;
    let mut visited = 0usize;

    while let Some(current_node) = current {
        let layout = tree
            .layout(current_node)
            .map_err(|_| KokoLayoutStatus::InternalError)?;
        x += layout.location.x;
        y += layout.location.y;
        visited = visited
            .checked_add(1)
            .ok_or(KokoLayoutStatus::InternalError)?;
        if visited > tree.total_node_count() {
            return Err(KokoLayoutStatus::InternalError);
        }
        current = tree.parent(current_node);
    }

    Ok((x, y))
}

#[no_mangle]
pub extern "C" fn koko_layout_session_new() -> *mut LayoutSession {
    catch_unwind(AssertUnwindSafe(|| {
        Box::into_raw(Box::new(LayoutSession::new()))
    }))
    .unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub unsafe extern "C" fn koko_layout_session_free(session: *mut LayoutSession) {
    if !session.is_null() {
        drop(Box::from_raw(session));
    }
}

#[no_mangle]
pub unsafe extern "C" fn koko_layout_metrics(
    session: *const LayoutSession,
    out: *mut KokoLayoutMetrics,
) -> KokoLayoutStatus {
    if session.is_null() || out.is_null() {
        return KokoLayoutStatus::InvalidArgument;
    }
    (*out).layout_computations = (*session).layout_computations;
    KokoLayoutStatus::Ok
}

#[no_mangle]
pub unsafe extern "C" fn koko_layout_session_begin_batch(
    session: *mut LayoutSession,
) -> KokoLayoutStatus {
    if session.is_null() {
        return KokoLayoutStatus::InvalidArgument;
    }
    status(|| {
        let session = &mut *session;
        session.batch_depth = match session.batch_depth.checked_add(1) {
            Some(depth) => depth,
            None => return KokoLayoutStatus::InternalError,
        };
        KokoLayoutStatus::Ok
    })
}

#[no_mangle]
pub unsafe extern "C" fn koko_layout_session_end_batch(
    session: *mut LayoutSession,
) -> KokoLayoutStatus {
    if session.is_null() {
        return KokoLayoutStatus::InvalidArgument;
    }
    status(|| {
        let session = &mut *session;
        if session.batch_depth == 0 {
            return KokoLayoutStatus::InvalidArgument;
        }
        session.batch_depth -= 1;
        KokoLayoutStatus::Ok
    })
}

/// Drop all Taffy nodes and their text contexts while retaining the session's
/// font/layout scratch allocators for the next document lifecycle.
#[no_mangle]
pub unsafe extern "C" fn koko_layout_session_reset(
    session: *mut LayoutSession,
) -> KokoLayoutStatus {
    if session.is_null() {
        return KokoLayoutStatus::InvalidArgument;
    }
    status(|| {
        let session = &mut *session;
        session.tree.clear();
        session.handles.clear();
        session.text_measure_cache.clear();
        session.next_handle = 1;
        session.batch_depth = 0;
        session.layout_ready = false;
        KokoLayoutStatus::Ok
    })
}

#[no_mangle]
pub unsafe extern "C" fn koko_layout_node_new(session: *mut LayoutSession) -> u64 {
    if session.is_null() {
        return 0;
    }
    catch_unwind(AssertUnwindSafe(|| {
        let session = &mut *session;
        session.invalidate();
        let node = session
            .tree
            .new_leaf_with_context(
                Style {
                    display: Display::Block,
                    ..Style::default()
                },
                LayoutNodeContext::default(),
            )
            .ok()?;
        session.allocate_handle(node).ok()
    }))
    .ok()
    .flatten()
    .unwrap_or(0)
}

/// Replace one node's complete computed-style snapshot in a single call.
/// Property bytes are borrowed only for the duration of this synchronous call;
/// Taffy receives owned typed values and no CSS strings cross the boundary
/// during layout.
#[no_mangle]
pub unsafe extern "C" fn koko_layout_node_set_computed_style(
    session: *mut LayoutSession,
    handle: u64,
    properties: *const KokoLayoutProperty,
    count: u64,
    viewport_width: f32,
    viewport_height: f32,
) -> KokoLayoutStatus {
    if session.is_null()
        || handle == 0
        || !valid_dimension(viewport_width)
        || !valid_dimension(viewport_height)
        || count > usize::MAX as u64
    {
        return KokoLayoutStatus::InvalidArgument;
    }
    status(|| {
        let session = &mut *session;
        let node = match session.node(handle) {
            Ok(node) => node,
            Err(error) => return error,
        };
        let snapshot = match property_snapshot(properties, count as usize) {
            Ok(snapshot) => snapshot,
            Err(error) => return error,
        };
        let mapped = match taffy_mapping::LayoutStyle::from_computed(
            &snapshot,
            taffy_mapping::Viewport::new(viewport_width, viewport_height),
        ) {
            Ok(mapped) => mapped,
            Err(error) => return mapping_status(error),
        };
        let style = match to_taffy_style(mapped) {
            Ok(style) => style,
            Err(error) => return error,
        };
        if session.tree.set_style(node, style).is_err() {
            return KokoLayoutStatus::InternalError;
        }
        if let Some(context) = session.tree.get_node_context_mut(node) {
            context.text_style = text_style_from_snapshot(&snapshot);
        }
        session.invalidate();
        KokoLayoutStatus::Ok
    })
}

/// Apply only text shaping and line-breaking properties to a node.
///
/// Unlike `koko_layout_node_set_computed_style`, this method does not parse or
/// replace any box/layout properties. The supplied list must contain only the
/// allowlisted inherited/text properties documented in `layout.h`.
#[no_mangle]
pub unsafe extern "C" fn koko_layout_node_set_text_style(
    session: *mut LayoutSession,
    handle: u64,
    properties: *const KokoLayoutProperty,
    count: u64,
) -> KokoLayoutStatus {
    if session.is_null() || handle == 0 || count > usize::MAX as u64 {
        return KokoLayoutStatus::InvalidArgument;
    }
    status(|| {
        let session = &mut *session;
        let node = match session.node(handle) {
            Ok(node) => node,
            Err(error) => return error,
        };
        let snapshot = match property_snapshot(properties, count as usize) {
            Ok(snapshot) => snapshot,
            Err(error) => return error,
        };
        let context = match session.tree.get_node_context_mut(node) {
            Some(context) => context,
            None => return KokoLayoutStatus::InternalError,
        };
        if let Err(error) = apply_text_style_snapshot(&mut context.text_style, &snapshot) {
            return error;
        }
        session.text_measure_cache.clear();
        session.invalidate();
        KokoLayoutStatus::Ok
    })
}

/// Set the UTF-8 text owned by a layout leaf. The bytes are copied exactly
/// once into the Rust-owned node context; no string pointer crosses into a
/// later layout pass.
#[no_mangle]
pub unsafe extern "C" fn koko_layout_node_set_text(
    session: *mut LayoutSession,
    handle: u64,
    text: *const u8,
    text_len: u64,
) -> KokoLayoutStatus {
    if session.is_null() || handle == 0 || text_len > usize::MAX as u64 {
        return KokoLayoutStatus::InvalidArgument;
    }
    if text_len > 0 && text.is_null() {
        return KokoLayoutStatus::InvalidArgument;
    }
    status(|| {
        let session = &mut *session;
        let node = match session.node(handle) {
            Ok(node) => node,
            Err(error) => return error,
        };
        let value = match std::str::from_utf8(std::slice::from_raw_parts(text, text_len as usize)) {
            Ok(value) => value.to_owned(),
            Err(_) => return KokoLayoutStatus::InvalidArgument,
        };
        let context = match session.tree.get_node_context_mut(node) {
            Some(context) => context,
            None => return KokoLayoutStatus::InternalError,
        };
        context.text = Some(value);
        session.invalidate();
        KokoLayoutStatus::Ok
    })
}

#[no_mangle]
pub unsafe extern "C" fn koko_layout_node_free(
    session: *mut LayoutSession,
    handle: u64,
) -> KokoLayoutStatus {
    if session.is_null() || handle == 0 {
        return KokoLayoutStatus::InvalidArgument;
    }
    status(|| {
        let session = &mut *session;
        let node = match session.handles.remove(&handle) {
            Some(node) => node,
            None => return KokoLayoutStatus::InvalidHandle,
        };
        if session.tree.remove(node).is_err() {
            return KokoLayoutStatus::InternalError;
        }
        session.invalidate();
        KokoLayoutStatus::Ok
    })
}

#[no_mangle]
pub unsafe extern "C" fn koko_layout_append_child(
    session: *mut LayoutSession,
    parent: u64,
    child: u64,
) -> KokoLayoutStatus {
    if session.is_null() || parent == 0 || child == 0 || parent == child {
        return KokoLayoutStatus::InvalidArgument;
    }
    status(|| {
        let session = &mut *session;
        let parent_node = match session.node(parent) {
            Ok(node) => node,
            Err(error) => return error,
        };
        let child_node = match session.node(child) {
            Ok(node) => node,
            Err(error) => return error,
        };
        if session.tree.add_child(parent_node, child_node).is_err() {
            return KokoLayoutStatus::InternalError;
        }
        session.invalidate();
        KokoLayoutStatus::Ok
    })
}

#[no_mangle]
pub unsafe extern "C" fn koko_layout_compute(
    session: *mut LayoutSession,
    root: u64,
    viewport_width: f32,
    viewport_height: f32,
) -> KokoLayoutStatus {
    if session.is_null()
        || root == 0
        || !valid_dimension(viewport_width)
        || !valid_dimension(viewport_height)
    {
        return KokoLayoutStatus::InvalidArgument;
    }
    status(|| {
        let session = &mut *session;
        let root_node = match session.node(root) {
            Ok(node) => node,
            Err(error) => return error,
        };
        session.layout_computations = session.layout_computations.wrapping_add(1);
        let available = Size {
            width: AvailableSpace::Definite(viewport_width),
            height: AvailableSpace::Definite(viewport_height),
        };
        let tree = &mut session.tree;
        let font_context = &mut session.font_context;
        let text_layout_context = &mut session.text_layout_context;
        let text_measure_cache = &mut session.text_measure_cache;
        let mut measure_failed = false;
        if tree
            .compute_layout_with_measure(root_node, available, |inputs, _, node_context, style| {
                taffy::compute_leaf_layout(
                    inputs,
                    style,
                    |_, _| 0.0,
                    |known_dimensions, available_space| {
                        let Some(node_context) = node_context.as_deref() else {
                            return known_dimensions.unwrap_or(Size::ZERO);
                        };
                        let Some(text) = node_context.text.as_deref() else {
                            return known_dimensions.unwrap_or(Size::ZERO);
                        };
                        let constraint = match available_space.width {
                            AvailableSpace::Definite(width) => {
                                parley_adapter::TextWidthConstraint::Definite(width.to_bits())
                            }
                            AvailableSpace::MinContent => {
                                parley_adapter::TextWidthConstraint::MinContent
                            }
                            AvailableSpace::MaxContent => {
                                parley_adapter::TextWidthConstraint::MaxContent
                            }
                        };
                        let key = TextMeasureCacheKey {
                            text: text.to_owned(),
                            style: node_context.text_style.clone(),
                            constraint,
                        };
                        let measured = if let Some(measured) = text_measure_cache.get(&key).copied()
                        {
                            measured
                        } else {
                            let measured = match parley_adapter::measure_with_parley(
                                font_context,
                                text_layout_context,
                                text,
                                &node_context.text_style,
                                constraint,
                            ) {
                                Ok(measured) => measured,
                                Err(_) => {
                                    measure_failed = true;
                                    return Size::ZERO;
                                }
                            };
                            if text_measure_cache.len() >= 1024 {
                                text_measure_cache.clear();
                            }
                            text_measure_cache.insert(key, measured);
                            measured
                        };
                        Size {
                            width: known_dimensions.width.unwrap_or(measured.0),
                            height: known_dimensions.height.unwrap_or(measured.1),
                        }
                    },
                )
            })
            .is_err()
        {
            return KokoLayoutStatus::InternalError;
        }
        if measure_failed {
            session.layout_ready = false;
            return KokoLayoutStatus::InternalError;
        }
        session.layout_ready = true;
        KokoLayoutStatus::Ok
    })
}

#[no_mangle]
pub unsafe extern "C" fn koko_layout_snapshot_batch(
    session: *const LayoutSession,
    nodes: *const u64,
    count: u64,
    out: *mut KokoLayoutGeometry,
    out_capacity: u64,
    out_count: *mut u64,
) -> KokoLayoutStatus {
    snapshot_batch(session, nodes, count, out, out_capacity, out_count, false)
}

/// Fills a caller-owned array with geometry whose `x`/`y` coordinates are
/// accumulated through each node's Taffy parents up to the tree root.
///
/// The remaining fields are identical to `koko_layout_snapshot_batch`. The
/// result is root/document-tree coordinates, not final viewport coordinates:
/// scrolling, transforms, fixed-position containing blocks, and iframe
/// offsets must still be applied by the Zig coordinator.
#[no_mangle]
pub unsafe extern "C" fn koko_layout_snapshot_absolute_batch(
    session: *const LayoutSession,
    nodes: *const u64,
    count: u64,
    out: *mut KokoLayoutGeometry,
    out_capacity: u64,
    out_count: *mut u64,
) -> KokoLayoutStatus {
    snapshot_batch(session, nodes, count, out, out_capacity, out_count, true)
}

unsafe fn snapshot_batch(
    session: *const LayoutSession,
    nodes: *const u64,
    count: u64,
    out: *mut KokoLayoutGeometry,
    out_capacity: u64,
    out_count: *mut u64,
    absolute: bool,
) -> KokoLayoutStatus {
    if session.is_null() || out_count.is_null() {
        return KokoLayoutStatus::InvalidArgument;
    }
    *out_count = 0;
    if count == 0 {
        return KokoLayoutStatus::Ok;
    }
    if count > usize::MAX as u64 || nodes.is_null() || out.is_null() || out_capacity < count {
        return KokoLayoutStatus::InvalidArgument;
    }
    status(|| {
        let session = &*session;
        if !session.layout_ready {
            return KokoLayoutStatus::NotReady;
        }
        let handles = std::slice::from_raw_parts(nodes, count as usize);
        let output = std::slice::from_raw_parts_mut(out, count as usize);

        // Validate every handle before writing anything to keep the batch
        // atomic from the caller's perspective.
        let mut node_ids = Vec::with_capacity(handles.len());
        for handle in handles {
            match session.node(*handle) {
                Ok(node) => node_ids.push(node),
                Err(error) => return error,
            }
        }
        for (slot, node) in output.iter_mut().zip(node_ids) {
            let layout = match session.tree.layout(node) {
                Ok(layout) => layout,
                Err(_) => return KokoLayoutStatus::InternalError,
            };
            let mut value = geometry(layout);
            if absolute {
                let (x, y) = match absolute_location(&session.tree, node) {
                    Ok(location) => location,
                    Err(error) => return error,
                };
                value.x = x;
                value.y = y;
            }
            *slot = value;
        }
        *out_count = count;
        KokoLayoutStatus::Ok
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn computed_properties(
        display: &str,
        width: &str,
        height: &str,
        grow: &str,
    ) -> Vec<(String, String)> {
        [
            ("display", display),
            ("box-sizing", "border-box"),
            ("width", width),
            ("height", height),
            ("min-width", "0px"),
            ("min-height", "0px"),
            ("max-width", "none"),
            ("max-height", "none"),
            ("margin-top", "0px"),
            ("margin-right", "0px"),
            ("margin-bottom", "0px"),
            ("margin-left", "0px"),
            ("padding-top", "0px"),
            ("padding-right", "0px"),
            ("padding-bottom", "0px"),
            ("padding-left", "0px"),
            ("border-top-width", "0px"),
            ("border-right-width", "0px"),
            ("border-bottom-width", "0px"),
            ("border-left-width", "0px"),
            ("row-gap", "0px"),
            ("column-gap", "0px"),
            ("flex-direction", "row"),
            ("flex-wrap", "nowrap"),
            ("flex-grow", grow),
            ("flex-shrink", "1"),
            ("flex-basis", "auto"),
            ("align-content", "normal"),
            ("align-items", "stretch"),
            ("align-self", "auto"),
            ("justify-content", "normal"),
            ("order", "0"),
            ("grid-template-columns", "none"),
            ("grid-template-rows", "none"),
            ("grid-auto-columns", "auto"),
            ("grid-auto-rows", "auto"),
            ("grid-auto-flow", "row"),
            ("position", "static"),
            ("top", "auto"),
            ("right", "auto"),
            ("bottom", "auto"),
            ("left", "auto"),
            ("z-index", "auto"),
            ("overflow-x", "visible"),
            ("overflow-y", "visible"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect()
    }

    fn property_abi(properties: &[(String, String)]) -> Vec<KokoLayoutProperty> {
        properties
            .iter()
            .map(|(name, value)| KokoLayoutProperty {
                name: name.as_ptr(),
                name_len: name.len(),
                value: value.as_ptr(),
                value_len: value.len(),
            })
            .collect()
    }

    unsafe fn styled_node(
        session: *mut LayoutSession,
        display: &str,
        width: &str,
        height: &str,
        overrides: &[(&str, &str)],
    ) -> u64 {
        let node = koko_layout_node_new(session);
        assert_ne!(node, 0);
        let mut values = computed_properties(display, width, height, "0");
        values.extend(
            overrides
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string())),
        );
        let abi = property_abi(&values);
        assert_eq!(
            koko_layout_node_set_computed_style(
                session,
                node,
                abi.as_ptr(),
                abi.len() as u64,
                600.0,
                600.0,
            ),
            KokoLayoutStatus::Ok,
            "computed style for {display} {width} × {height}: {overrides:?}",
        );
        node
    }

    unsafe fn compute_geometry(
        session: *mut LayoutSession,
        root: u64,
        nodes: &[u64],
    ) -> Vec<KokoLayoutGeometry> {
        assert_eq!(
            koko_layout_compute(session, root, 600.0, 600.0),
            KokoLayoutStatus::Ok
        );
        let mut geometry = vec![KokoLayoutGeometry::default(); nodes.len()];
        let mut count = 0;
        assert_eq!(
            koko_layout_snapshot_batch(
                session,
                nodes.as_ptr(),
                nodes.len() as u64,
                geometry.as_mut_ptr(),
                geometry.len() as u64,
                &mut count,
            ),
            KokoLayoutStatus::Ok,
        );
        assert_eq!(count, nodes.len() as u64);
        geometry
    }

    #[test]
    fn flex_wrap_uses_line_cross_size_from_align_content_wrap_002() {
        unsafe {
            for (direction, width, height) in
                [("row", "600px", "100px"), ("column", "100px", "600px")]
            {
                for (wrap, item_count, expected) in
                    [("nowrap", 3, 80.0), ("wrap", 3, 150.0), ("wrap", 5, 150.0)]
                {
                    let mut session = LayoutSession::new();
                    let session = &mut session as *mut LayoutSession;
                    let root = styled_node(
                        session,
                        "flex",
                        width,
                        height,
                        &[
                            ("flex-direction", direction),
                            ("flex-wrap", wrap),
                            ("align-items", "normal"),
                            ("row-gap", "normal"),
                            ("column-gap", "normal"),
                        ],
                    );
                    let mut items = Vec::new();
                    for cross in ["150px", "100px", "50px", "150px", "100px"]
                        .into_iter()
                        .take(item_count)
                    {
                        let (item_width, item_height, content_width, content_height) =
                            if direction == "row" {
                                ("150px", "auto", "100px", cross)
                            } else {
                                ("auto", "150px", cross, "100px")
                            };
                        let item = styled_node(
                            session,
                            "block",
                            item_width,
                            item_height,
                            &[
                                ("min-width", "auto"),
                                ("min-height", "auto"),
                                ("flex-shrink", "0"),
                                ("margin-top", "10px"),
                                ("margin-bottom", "10px"),
                                ("margin-left", "10px"),
                                ("margin-right", "10px"),
                                ("row-gap", "normal"),
                                ("column-gap", "normal"),
                            ],
                        );
                        let content =
                            styled_node(session, "block", content_width, content_height, &[]);
                        assert_eq!(
                            koko_layout_append_child(session, item, content),
                            KokoLayoutStatus::Ok
                        );
                        assert_eq!(
                            koko_layout_append_child(session, root, item),
                            KokoLayoutStatus::Ok
                        );
                        items.push(item);
                    }
                    for rect in compute_geometry(session, root, &items) {
                        let cross = if direction == "row" {
                            rect.height
                        } else {
                            rect.width
                        };
                        assert_eq!(cross, expected, "{direction} {wrap}, {item_count} items");
                    }
                }
            }
        }
    }

    #[test]
    fn flex_preserves_gap_and_item_alignment() {
        unsafe {
            let mut session = LayoutSession::new();
            let session = &mut session as *mut LayoutSession;
            let root = styled_node(
                session,
                "flex",
                "100px",
                "60px",
                &[("align-items", "center"), ("column-gap", "10%")],
            );
            let first = styled_node(session, "block", "20px", "20px", &[]);
            let second = styled_node(
                session,
                "block",
                "20px",
                "auto",
                &[("align-self", "stretch")],
            );
            for child in [first, second] {
                assert_eq!(
                    koko_layout_append_child(session, root, child),
                    KokoLayoutStatus::Ok
                );
            }
            let rects = compute_geometry(session, root, &[first, second]);
            assert_eq!((rects[0].x, rects[0].y, rects[0].height), (0.0, 20.0, 20.0));
            assert_eq!((rects[1].x, rects[1].y, rects[1].height), (30.0, 0.0, 60.0));
        }
    }

    #[test]
    fn grid_uses_computed_implicit_tracks_and_auto_flow() {
        unsafe {
            let mut session = LayoutSession::new();
            let session = &mut session as *mut LayoutSession;
            let root = styled_node(
                session,
                "grid",
                "200px",
                "100px",
                &[
                    ("grid-template-rows", "20px 25px"),
                    ("grid-auto-columns", "50px"),
                    ("grid-auto-flow", "column dense"),
                    ("row-gap", "5px"),
                    ("column-gap", "8px"),
                ],
            );
            let items = [0; 3].map(|_| {
                let node = styled_node(session, "block", "auto", "auto", &[]);
                assert_eq!(
                    koko_layout_append_child(session, root, node),
                    KokoLayoutStatus::Ok
                );
                node
            });
            let rects = compute_geometry(session, root, &items);
            let boxes: Vec<_> = rects
                .iter()
                .map(|rect| (rect.x, rect.y, rect.width, rect.height))
                .collect();
            assert_eq!(
                boxes,
                [
                    (0.0, 0.0, 50.0, 20.0),
                    (0.0, 25.0, 50.0, 25.0),
                    (58.0, 0.0, 50.0, 20.0)
                ]
            );
        }
    }

    #[test]
    fn grid_minmax_tracks_preserve_default_auto_placement() {
        unsafe {
            let mut session = LayoutSession::new();
            let session = &mut session as *mut LayoutSession;
            let root = styled_node(
                session,
                "grid",
                "200px",
                "100px",
                &[
                    ("grid-template-columns", "minmax(30px, 50px) 1fr"),
                    ("row-gap", "normal"),
                    ("column-gap", "normal"),
                ],
            );
            let items = [0; 3].map(|_| {
                let node = styled_node(session, "block", "auto", "auto", &[]);
                assert_eq!(
                    koko_layout_append_child(session, root, node),
                    KokoLayoutStatus::Ok
                );
                node
            });
            let rects = compute_geometry(session, root, &items);
            let boxes: Vec<_> = rects
                .iter()
                .map(|rect| (rect.x, rect.y, rect.width, rect.height))
                .collect();
            assert_eq!(
                boxes,
                [
                    (0.0, 0.0, 50.0, 50.0),
                    (50.0, 0.0, 150.0, 50.0),
                    (0.0, 50.0, 50.0, 50.0),
                ]
            );
        }
    }

    #[test]
    fn flex_layout_uses_mapped_computed_values() {
        unsafe {
            let session = koko_layout_session_new();
            assert!(!session.is_null());
            let root = koko_layout_node_new(session);
            let first = koko_layout_node_new(session);
            let second = koko_layout_node_new(session);

            let root_values = computed_properties("flex", "600px", "100px", "0");
            let child_values = computed_properties("block", "0px", "20px", "1");
            let root_abi = property_abi(&root_values);
            let first_abi = property_abi(&child_values);
            let second_abi = property_abi(&child_values);

            assert_eq!(
                koko_layout_node_set_computed_style(
                    session,
                    root,
                    root_abi.as_ptr(),
                    root_abi.len() as u64,
                    600.0,
                    100.0,
                ),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_node_set_computed_style(
                    session,
                    first,
                    first_abi.as_ptr(),
                    first_abi.len() as u64,
                    600.0,
                    100.0,
                ),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_node_set_computed_style(
                    session,
                    second,
                    second_abi.as_ptr(),
                    second_abi.len() as u64,
                    600.0,
                    100.0,
                ),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_append_child(session, root, first),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_append_child(session, root, second),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_compute(session, root, 600.0, 100.0),
                KokoLayoutStatus::Ok
            );

            let handles = [root, first, second];
            let mut output = [KokoLayoutGeometry::default(); 3];
            let mut count = 0;
            assert_eq!(
                koko_layout_snapshot_batch(
                    session,
                    handles.as_ptr(),
                    handles.len() as u64,
                    output.as_mut_ptr(),
                    output.len() as u64,
                    &mut count,
                ),
                KokoLayoutStatus::Ok
            );
            assert_eq!(count, 3);
            assert_eq!(output[0].width, 600.0);
            assert_eq!(output[1].width, 300.0);
            assert_eq!(output[2].width, 300.0);
            assert_eq!(output[2].x, 300.0);
            koko_layout_session_free(session);
        }
    }

    #[test]
    fn absolute_snapshot_accumulates_parent_locations() {
        unsafe {
            let session = koko_layout_session_new();
            assert!(!session.is_null());
            let root = koko_layout_node_new(session);
            let parent = koko_layout_node_new(session);
            let child = koko_layout_node_new(session);

            let mut root_values = computed_properties("flex", "600px", "100px", "0");
            root_values
                .iter_mut()
                .find(|(name, _)| name == "align-items")
                .unwrap()
                .1 = "center".to_owned();
            let parent_values = computed_properties("block", "0px", "20px", "1");
            let mut child_values = computed_properties("block", "50px", "10px", "0");
            child_values
                .iter_mut()
                .find(|(name, _)| name == "margin-top")
                .unwrap()
                .1 = "13px".to_owned();

            let root_abi = property_abi(&root_values);
            let parent_abi = property_abi(&parent_values);
            let child_abi = property_abi(&child_values);
            assert_eq!(
                koko_layout_node_set_computed_style(
                    session,
                    root,
                    root_abi.as_ptr(),
                    root_abi.len() as u64,
                    600.0,
                    100.0,
                ),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_node_set_computed_style(
                    session,
                    parent,
                    parent_abi.as_ptr(),
                    parent_abi.len() as u64,
                    600.0,
                    100.0,
                ),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_node_set_computed_style(
                    session,
                    child,
                    child_abi.as_ptr(),
                    child_abi.len() as u64,
                    600.0,
                    100.0,
                ),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_append_child(session, root, parent),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_append_child(session, parent, child),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_compute(session, root, 600.0, 100.0),
                KokoLayoutStatus::Ok
            );

            let nodes = [parent, child];
            let mut local = [KokoLayoutGeometry::default(); 2];
            let mut absolute = [KokoLayoutGeometry::default(); 2];
            let mut local_count = 0;
            let mut absolute_count = 0;
            assert_eq!(
                koko_layout_snapshot_batch(
                    session,
                    nodes.as_ptr(),
                    nodes.len() as u64,
                    local.as_mut_ptr(),
                    local.len() as u64,
                    &mut local_count,
                ),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_snapshot_absolute_batch(
                    session,
                    nodes.as_ptr(),
                    nodes.len() as u64,
                    absolute.as_mut_ptr(),
                    absolute.len() as u64,
                    &mut absolute_count,
                ),
                KokoLayoutStatus::Ok
            );
            assert_eq!(local_count, nodes.len() as u64);
            assert_eq!(absolute_count, nodes.len() as u64);
            assert!((absolute[1].x - (absolute[0].x + local[1].x)).abs() < 0.001);
            assert!((absolute[1].y - (absolute[0].y + local[1].y)).abs() < 0.001);
            assert!(absolute[0].y > 0.0);
            assert!(local[1].y > 0.0);
            koko_layout_session_free(session);
        }
    }

    #[test]
    fn text_leaf_uses_parley_measurement() {
        unsafe {
            let session = koko_layout_session_new();
            assert!(!session.is_null());
            let root = koko_layout_node_new(session);
            let text = koko_layout_node_new(session);
            assert_ne!(root, 0);
            assert_ne!(text, 0);

            let root_values = computed_properties("block", "240px", "auto", "0");
            let text_values = computed_properties("block", "auto", "auto", "0");
            let root_abi = property_abi(&root_values);
            let text_abi = property_abi(&text_values);
            assert_eq!(
                koko_layout_node_set_computed_style(
                    session,
                    root,
                    root_abi.as_ptr(),
                    root_abi.len() as u64,
                    240.0,
                    100.0,
                ),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_node_set_computed_style(
                    session,
                    text,
                    text_abi.as_ptr(),
                    text_abi.len() as u64,
                    240.0,
                    100.0,
                ),
                KokoLayoutStatus::Ok
            );
            let text_bytes = "Parley shapes this text before Taffy computes its intrinsic size.";
            assert_eq!(
                koko_layout_node_set_text(
                    session,
                    text,
                    text_bytes.as_ptr(),
                    text_bytes.len() as u64
                ),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_append_child(session, root, text),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_compute(session, root, 240.0, 100.0),
                KokoLayoutStatus::Ok
            );

            let mut output = [KokoLayoutGeometry::default(); 1];
            let handles = [text];
            let mut count = 0;
            assert_eq!(
                koko_layout_snapshot_batch(
                    session,
                    handles.as_ptr(),
                    1,
                    output.as_mut_ptr(),
                    1,
                    &mut count,
                ),
                KokoLayoutStatus::Ok
            );
            assert_eq!(count, 1);
            assert!(output[0].width > 0.0);
            assert!(output[0].height > 0.0);
            koko_layout_session_free(session);
        }
    }

    #[test]
    fn text_style_can_update_leaf_without_layout_properties() {
        unsafe {
            let session = koko_layout_session_new();
            assert!(!session.is_null());
            let root = koko_layout_node_new(session);
            let text = koko_layout_node_new(session);

            let root_values = computed_properties("block", "240px", "100px", "0");
            let root_abi = property_abi(&root_values);
            assert_eq!(
                koko_layout_node_set_computed_style(
                    session,
                    root,
                    root_abi.as_ptr(),
                    root_abi.len() as u64,
                    240.0,
                    100.0,
                ),
                KokoLayoutStatus::Ok
            );

            let text_style_values = vec![
                ("font-size".to_owned(), "20px".to_owned()),
                ("line-height".to_owned(), "24px".to_owned()),
                ("direction".to_owned(), "ltr".to_owned()),
                ("white-space".to_owned(), "normal".to_owned()),
            ];
            let text_style_abi = property_abi(&text_style_values);
            assert_eq!(
                koko_layout_node_set_text_style(
                    session,
                    text,
                    text_style_abi.as_ptr(),
                    text_style_abi.len() as u64,
                ),
                KokoLayoutStatus::Ok
            );
            let text_bytes = "Text style ABI keeps layout properties optional.";
            assert_eq!(
                koko_layout_node_set_text(
                    session,
                    text,
                    text_bytes.as_ptr(),
                    text_bytes.len() as u64,
                ),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_append_child(session, root, text),
                KokoLayoutStatus::Ok
            );
            assert_eq!(
                koko_layout_compute(session, root, 240.0, 100.0),
                KokoLayoutStatus::Ok
            );

            let handles = [text];
            let mut output = [KokoLayoutGeometry::default(); 1];
            let mut count = 0;
            assert_eq!(
                koko_layout_snapshot_absolute_batch(
                    session,
                    handles.as_ptr(),
                    1,
                    output.as_mut_ptr(),
                    1,
                    &mut count,
                ),
                KokoLayoutStatus::Ok
            );
            assert_eq!(count, 1);
            assert!(output[0].width > 0.0);
            assert!(output[0].height >= 24.0);
            koko_layout_session_free(session);
        }
    }
}
