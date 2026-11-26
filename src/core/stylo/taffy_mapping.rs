//! Stylo computed-value to layout-style mapping.
//!
//! This module deliberately does not own a DOM and does not resolve missing
//! values.  The Stylo integration supplies serialized computed values through
//! [`ComputedStyleSource`], and this adapter converts them into a small,
//! Taffy-shaped intermediate representation.  The eventual Taffy bridge can
//! consume this representation without crossing the Zig/Rust boundary for
//! individual CSS properties.
//!
//! The current Stylo crate does not depend on Taffy yet, so this file keeps the
//! intermediate types local.  The mapping is intentionally strict: unsupported
//! CSS syntax is reported instead of being silently replaced with a guessed
//! value.

use std::fmt;

/// A source of serialized Stylo computed values.
///
/// A `ComputedValues` implementation should use Stylo's
/// `PropertyId::parse_enabled_for_all_content` and
/// `ComputedValues::computed_value_to_string` to implement this trait.  The
/// source returns owned strings because Stylo serializes a value on demand.
pub trait ComputedStyleSource {
    fn computed_property(&self, property: &str) -> Option<String>;
}

/// Viewport context used only when a source exposes viewport units instead of
/// Stylo's usual resolved pixel serialization.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    pub width: f32,
    pub height: f32,
}

impl Viewport {
    pub const fn new(width: f32, height: f32) -> Self {
        Self { width, height }
    }

    fn valid(self) -> bool {
        self.width.is_finite() && self.width >= 0.0 && self.height.is_finite() && self.height >= 0.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Display {
    None,
    Contents,
    Block,
    Inline,
    FlowRoot,
    Flex,
    InlineFlex,
    Grid,
    InlineGrid,
    Table,
    InlineTable,
    ListItem,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoxSizing {
    ContentBox,
    BorderBox,
}

/// A CSS dimension preserved in a form that can be mapped to Taffy's
/// `Dimension`/`LengthPercentage` types without losing percentages.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Length {
    Px(f32),
    Percent(f32),
    Auto,
    None,
    MinContent,
    MaxContent,
    FitContent,
}

impl Length {
    pub const ZERO: Self = Self::Px(0.0);
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Edges<T> {
    pub top: T,
    pub right: T,
    pub bottom: T,
    pub left: T,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    pub width: Length,
    pub height: Length,
    pub min_width: Length,
    pub min_height: Length,
    pub max_width: Length,
    pub max_height: Length,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Border {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlexDirection {
    Row,
    RowReverse,
    Column,
    ColumnReverse,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlexWrap {
    NoWrap,
    Wrap,
    WrapReverse,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Auto,
    Normal,
    Start,
    End,
    FlexStart,
    FlexEnd,
    Center,
    Stretch,
    Baseline,
    SpaceBetween,
    SpaceAround,
    SpaceEvenly,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Flex {
    pub direction: FlexDirection,
    pub wrap: FlexWrap,
    pub grow: f32,
    pub shrink: f32,
    pub basis: Length,
    pub row_gap: Length,
    pub column_gap: Length,
    pub align_content: Align,
    pub align_items: Align,
    pub align_self: Align,
    pub justify_content: Align,
    pub order: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum GridTrack {
    Px(f32),
    Percent(f32),
    Flex(f32),
    Auto,
    MinContent,
    MaxContent,
    MinMax(Box<Self>, Box<Self>),
    FitContent(Box<Self>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum GridTemplate {
    None,
    Tracks(Vec<GridTrack>),
    /// A valid CSS grid template that needs a Taffy-specific representation
    /// before it can be laid out.  Keeping the source is preferable to
    /// inventing track sizes.
    Unsupported(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GridAutoFlow {
    Row,
    Column,
    RowDense,
    ColumnDense,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Grid {
    pub columns: GridTemplate,
    pub rows: GridTemplate,
    pub auto_columns: Length,
    pub auto_rows: Length,
    pub auto_flow: GridAutoFlow,
    pub row_gap: Length,
    pub column_gap: Length,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Position {
    Static,
    Relative,
    Absolute,
    Fixed,
    Sticky,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PositionStyle {
    pub position: Position,
    pub top: Length,
    pub right: Length,
    pub bottom: Length,
    pub left: Length,
    pub z_index: Option<i32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Overflow {
    Visible,
    Hidden,
    Clip,
    Scroll,
    Auto,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OverflowStyle {
    pub x: Overflow,
    pub y: Overflow,
}

/// All layout inputs needed by a Taffy node, kept in one Rust-side batch.
#[derive(Clone, Debug, PartialEq)]
pub struct LayoutStyle {
    pub display: Display,
    pub box_sizing: BoxSizing,
    pub size: Size,
    pub margin: Edges<Length>,
    pub padding: Edges<Length>,
    pub border: Border,
    pub flex: Flex,
    pub grid: Grid,
    pub position: PositionStyle,
    pub overflow: OverflowStyle,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MappingError {
    MissingProperty(String),
    InvalidValue { property: String, value: String },
    UnsupportedValue { property: String, value: String },
    InvalidViewport,
}

impl fmt::Display for MappingError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingProperty(property) => write!(out, "missing computed property {property}"),
            Self::InvalidValue { property, value } => {
                write!(out, "invalid computed value for {property}: {value:?}")
            }
            Self::UnsupportedValue { property, value } => {
                write!(out, "unsupported computed value for {property}: {value:?}")
            }
            Self::InvalidViewport => {
                write!(out, "viewport dimensions must be finite and non-negative")
            }
        }
    }
}

impl std::error::Error for MappingError {}

impl LayoutStyle {
    /// Map one complete Stylo computed-style snapshot.
    pub fn from_computed<S: ComputedStyleSource>(
        source: &S,
        viewport: Viewport,
    ) -> Result<Self, MappingError> {
        if !viewport.valid() {
            return Err(MappingError::InvalidViewport);
        }

        let display = parse_display(&required(source, "display")?)?;
        let box_sizing = parse_box_sizing(&required(source, "box-sizing")?)?;
        let size = Size {
            width: parse_length(&required(source, "width")?, "width", viewport, true)?,
            height: parse_length(&required(source, "height")?, "height", viewport, true)?,
            min_width: parse_length(&required(source, "min-width")?, "min-width", viewport, true)?,
            min_height: parse_length(
                &required(source, "min-height")?,
                "min-height",
                viewport,
                true,
            )?,
            max_width: parse_length_with_none(
                &required(source, "max-width")?,
                "max-width",
                viewport,
                true,
            )?,
            max_height: parse_length_with_none(
                &required(source, "max-height")?,
                "max-height",
                viewport,
                true,
            )?,
        };

        let margin = parse_edges(source, "margin", viewport, true)?;
        let padding = parse_edges(source, "padding", viewport, false)?;
        let border = Border {
            top: parse_px(
                &required(source, "border-top-width")?,
                "border-top-width",
                viewport,
            )?,
            right: parse_px(
                &required(source, "border-right-width")?,
                "border-right-width",
                viewport,
            )?,
            bottom: parse_px(
                &required(source, "border-bottom-width")?,
                "border-bottom-width",
                viewport,
            )?,
            left: parse_px(
                &required(source, "border-left-width")?,
                "border-left-width",
                viewport,
            )?,
        };

        let row_gap = parse_length(&required(source, "row-gap")?, "row-gap", viewport, false)?;
        let column_gap = parse_length(
            &required(source, "column-gap")?,
            "column-gap",
            viewport,
            false,
        )?;
        let flex = Flex {
            direction: parse_flex_direction(&required(source, "flex-direction")?)?,
            wrap: parse_flex_wrap(&required(source, "flex-wrap")?)?,
            grow: parse_number(&required(source, "flex-grow")?, "flex-grow")?,
            shrink: parse_number(&required(source, "flex-shrink")?, "flex-shrink")?,
            basis: parse_length(
                &required(source, "flex-basis")?,
                "flex-basis",
                viewport,
                true,
            )?,
            row_gap,
            column_gap,
            align_content: parse_align(&required(source, "align-content")?, "align-content")?,
            align_items: parse_align(&required(source, "align-items")?, "align-items")?,
            align_self: parse_align(&required(source, "align-self")?, "align-self")?,
            justify_content: parse_align(&required(source, "justify-content")?, "justify-content")?,
            order: parse_integer(&required(source, "order")?, "order")?,
        };

        let grid = Grid {
            columns: parse_grid_template(
                &required(source, "grid-template-columns")?,
                "grid-template-columns",
                viewport,
            )?,
            rows: parse_grid_template(
                &required(source, "grid-template-rows")?,
                "grid-template-rows",
                viewport,
            )?,
            auto_columns: parse_length(
                &required(source, "grid-auto-columns")?,
                "grid-auto-columns",
                viewport,
                true,
            )?,
            auto_rows: parse_length(
                &required(source, "grid-auto-rows")?,
                "grid-auto-rows",
                viewport,
                true,
            )?,
            auto_flow: parse_grid_auto_flow(&required(source, "grid-auto-flow")?)?,
            row_gap,
            column_gap,
        };

        let position = PositionStyle {
            position: parse_position(&required(source, "position")?)?,
            top: parse_length(&required(source, "top")?, "top", viewport, true)?,
            right: parse_length(&required(source, "right")?, "right", viewport, true)?,
            bottom: parse_length(&required(source, "bottom")?, "bottom", viewport, true)?,
            left: parse_length(&required(source, "left")?, "left", viewport, true)?,
            z_index: parse_z_index(&required(source, "z-index")?, "z-index")?,
        };

        let overflow = OverflowStyle {
            x: parse_overflow(&required(source, "overflow-x")?, "overflow-x")?,
            y: parse_overflow(&required(source, "overflow-y")?, "overflow-y")?,
        };

        Ok(Self {
            display,
            box_sizing,
            size,
            margin,
            padding,
            border,
            flex,
            grid,
            position,
            overflow,
        })
    }
}

fn required<S: ComputedStyleSource>(source: &S, property: &str) -> Result<String, MappingError> {
    source
        .computed_property(property)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| MappingError::MissingProperty(property.to_owned()))
}

fn invalid(property: &str, value: &str) -> MappingError {
    MappingError::InvalidValue {
        property: property.to_owned(),
        value: value.to_owned(),
    }
}

fn unsupported(property: &str, value: &str) -> MappingError {
    MappingError::UnsupportedValue {
        property: property.to_owned(),
        value: value.to_owned(),
    }
}

fn parse_display(value: &str) -> Result<Display, MappingError> {
    match value.trim().to_ascii_lowercase().as_str() {
        "none" => Ok(Display::None),
        "contents" => Ok(Display::Contents),
        "block" => Ok(Display::Block),
        "inline" => Ok(Display::Inline),
        "flow-root" => Ok(Display::FlowRoot),
        "flex" => Ok(Display::Flex),
        "inline-flex" => Ok(Display::InlineFlex),
        "grid" => Ok(Display::Grid),
        "inline-grid" => Ok(Display::InlineGrid),
        "table" => Ok(Display::Table),
        "inline-table" => Ok(Display::InlineTable),
        "list-item" => Ok(Display::ListItem),
        _ => Err(unsupported("display", value)),
    }
}

fn parse_box_sizing(value: &str) -> Result<BoxSizing, MappingError> {
    match value.trim() {
        "content-box" => Ok(BoxSizing::ContentBox),
        "border-box" => Ok(BoxSizing::BorderBox),
        _ => Err(unsupported("box-sizing", value)),
    }
}

fn parse_edges<S: ComputedStyleSource>(
    source: &S,
    prefix: &str,
    viewport: Viewport,
    allow_auto: bool,
) -> Result<Edges<Length>, MappingError> {
    Ok(Edges {
        top: parse_length(
            &required(source, &format!("{prefix}-top"))?,
            &format!("{prefix}-top"),
            viewport,
            allow_auto,
        )?,
        right: parse_length(
            &required(source, &format!("{prefix}-right"))?,
            &format!("{prefix}-right"),
            viewport,
            allow_auto,
        )?,
        bottom: parse_length(
            &required(source, &format!("{prefix}-bottom"))?,
            &format!("{prefix}-bottom"),
            viewport,
            allow_auto,
        )?,
        left: parse_length(
            &required(source, &format!("{prefix}-left"))?,
            &format!("{prefix}-left"),
            viewport,
            allow_auto,
        )?,
    })
}

fn parse_length(
    value: &str,
    property: &str,
    viewport: Viewport,
    allow_auto: bool,
) -> Result<Length, MappingError> {
    parse_length_with_options(value, property, viewport, allow_auto, false)
}

fn parse_length_with_none(
    value: &str,
    property: &str,
    viewport: Viewport,
    allow_auto: bool,
) -> Result<Length, MappingError> {
    parse_length_with_options(value, property, viewport, allow_auto, true)
}

fn parse_length_with_options(
    value: &str,
    property: &str,
    viewport: Viewport,
    allow_auto: bool,
    allow_none: bool,
) -> Result<Length, MappingError> {
    let value = value.trim();
    let lower = value.to_ascii_lowercase();
    if value.is_empty() {
        return Err(invalid(property, value));
    }
    if lower == "auto" {
        return if allow_auto {
            Ok(Length::Auto)
        } else {
            Err(unsupported(property, value))
        };
    }
    if lower == "none" {
        return if allow_none {
            Ok(Length::None)
        } else {
            Err(unsupported(property, value))
        };
    }
    if lower == "min-content" {
        return Ok(Length::MinContent);
    }
    if lower == "max-content" {
        return Ok(Length::MaxContent);
    }
    if lower == "fit-content" {
        return Ok(Length::FitContent);
    }
    if lower.starts_with("calc(")
        || lower.starts_with("min(")
        || lower.starts_with("max(")
        || lower.starts_with("clamp(")
    {
        return Err(unsupported(property, value));
    }
    if let Some(number) = lower.strip_suffix('%') {
        return Ok(Length::Percent(
            parse_finite(number, property, value)? / 100.0,
        ));
    }
    for (suffix, scale) in [
        ("px", 1.0),
        ("vw", viewport.width / 100.0),
        ("vh", viewport.height / 100.0),
        ("vmin", viewport.width.min(viewport.height) / 100.0),
        ("vmax", viewport.width.max(viewport.height) / 100.0),
    ] {
        if let Some(number) = lower.strip_suffix(suffix) {
            let value = parse_finite(number, property, value)? * scale;
            return Ok(Length::Px(value));
        }
    }
    if let Ok(number) = value.parse::<f32>() {
        if number.is_finite() {
            return Ok(Length::Px(number));
        }
    }
    Err(unsupported(property, value))
}

fn parse_px(value: &str, property: &str, viewport: Viewport) -> Result<f32, MappingError> {
    match parse_length(value, property, viewport, false)? {
        Length::Px(value) if value >= 0.0 => Ok(value),
        Length::Px(_) => Err(invalid(property, value)),
        _ => Err(unsupported(property, value)),
    }
}

fn parse_finite(number: &str, property: &str, value: &str) -> Result<f32, MappingError> {
    number
        .trim()
        .parse::<f32>()
        .ok()
        .filter(|number| number.is_finite())
        .ok_or_else(|| invalid(property, value))
}

fn parse_number(value: &str, property: &str) -> Result<f32, MappingError> {
    parse_finite(value.trim(), property, value)
}

fn parse_integer(value: &str, property: &str) -> Result<i32, MappingError> {
    value
        .trim()
        .parse::<i32>()
        .map_err(|_| invalid(property, value))
}

fn parse_flex_direction(value: &str) -> Result<FlexDirection, MappingError> {
    match value.trim() {
        "row" => Ok(FlexDirection::Row),
        "row-reverse" => Ok(FlexDirection::RowReverse),
        "column" => Ok(FlexDirection::Column),
        "column-reverse" => Ok(FlexDirection::ColumnReverse),
        _ => Err(unsupported("flex-direction", value)),
    }
}

fn parse_flex_wrap(value: &str) -> Result<FlexWrap, MappingError> {
    match value.trim() {
        "nowrap" => Ok(FlexWrap::NoWrap),
        "wrap" => Ok(FlexWrap::Wrap),
        "wrap-reverse" => Ok(FlexWrap::WrapReverse),
        _ => Err(unsupported("flex-wrap", value)),
    }
}

fn parse_align(value: &str, property: &str) -> Result<Align, MappingError> {
    match value.trim() {
        "auto" => Ok(Align::Auto),
        "normal" => Ok(Align::Normal),
        "start" => Ok(Align::Start),
        "end" => Ok(Align::End),
        "flex-start" => Ok(Align::FlexStart),
        "flex-end" => Ok(Align::FlexEnd),
        "center" => Ok(Align::Center),
        "stretch" => Ok(Align::Stretch),
        "baseline" => Ok(Align::Baseline),
        "space-between" => Ok(Align::SpaceBetween),
        "space-around" => Ok(Align::SpaceAround),
        "space-evenly" => Ok(Align::SpaceEvenly),
        _ => Err(unsupported(property, value)),
    }
}

fn parse_grid_auto_flow(value: &str) -> Result<GridAutoFlow, MappingError> {
    match value.trim() {
        "row" => Ok(GridAutoFlow::Row),
        "column" => Ok(GridAutoFlow::Column),
        "row dense" => Ok(GridAutoFlow::RowDense),
        "column dense" => Ok(GridAutoFlow::ColumnDense),
        _ => Err(unsupported("grid-auto-flow", value)),
    }
}

fn parse_position(value: &str) -> Result<Position, MappingError> {
    match value.trim() {
        "static" => Ok(Position::Static),
        "relative" => Ok(Position::Relative),
        "absolute" => Ok(Position::Absolute),
        "fixed" => Ok(Position::Fixed),
        "sticky" => Ok(Position::Sticky),
        _ => Err(unsupported("position", value)),
    }
}

fn parse_z_index(value: &str, property: &str) -> Result<Option<i32>, MappingError> {
    if value.trim() == "auto" {
        return Ok(None);
    }
    Ok(Some(parse_integer(value, property)?))
}

fn parse_overflow(value: &str, property: &str) -> Result<Overflow, MappingError> {
    match value.trim() {
        "visible" => Ok(Overflow::Visible),
        "hidden" => Ok(Overflow::Hidden),
        "clip" => Ok(Overflow::Clip),
        "scroll" => Ok(Overflow::Scroll),
        "auto" => Ok(Overflow::Auto),
        _ => Err(unsupported(property, value)),
    }
}

fn parse_grid_template(
    value: &str,
    property: &str,
    viewport: Viewport,
) -> Result<GridTemplate, MappingError> {
    let value = value.trim();
    if value == "none" {
        return Ok(GridTemplate::None);
    }
    if value == "subgrid" || value == "masonry" || value.contains("repeat(") {
        return Ok(GridTemplate::Unsupported(value.to_owned()));
    }
    let mut tracks = Vec::new();
    for token in split_top_level(value, ' ') {
        if token.is_empty() {
            continue;
        }
        tracks.push(parse_grid_track(&token, property, viewport)?);
    }
    if tracks.is_empty() {
        Err(invalid(property, value))
    } else {
        Ok(GridTemplate::Tracks(tracks))
    }
}

fn parse_grid_track(
    value: &str,
    property: &str,
    viewport: Viewport,
) -> Result<GridTrack, MappingError> {
    let value = value.trim();
    match value {
        "auto" => Ok(GridTrack::Auto),
        "min-content" => Ok(GridTrack::MinContent),
        "max-content" => Ok(GridTrack::MaxContent),
        _ if value.ends_with("fr") => Ok(GridTrack::Flex(parse_finite(
            &value[..value.len() - 2],
            property,
            value,
        )?)),
        _ if value.starts_with("minmax(") && value.ends_with(')') => {
            let inner = &value[7..value.len() - 1];
            let parts = split_top_level(inner, ',');
            if parts.len() != 2 {
                return Err(invalid(property, value));
            }
            Ok(GridTrack::MinMax(
                Box::new(parse_grid_track(&parts[0], property, viewport)?),
                Box::new(parse_grid_track(&parts[1], property, viewport)?),
            ))
        }
        _ if value.starts_with("fit-content(") && value.ends_with(')') => {
            let inner = &value[12..value.len() - 1];
            Ok(GridTrack::FitContent(Box::new(parse_grid_track(
                inner, property, viewport,
            )?)))
        }
        _ => match parse_length(value, property, viewport, false)? {
            Length::Px(value) => Ok(GridTrack::Px(value)),
            Length::Percent(value) => Ok(GridTrack::Percent(value)),
            _ => Err(unsupported(property, value)),
        },
    }
}

fn split_top_level(value: &str, separator: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut depth = 0usize;
    for (index, character) in value.char_indices() {
        match character {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            c if c == separator && depth == 0 => {
                parts.push(value[start..index].trim().to_owned());
                start = index + character.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(value[start..].trim().to_owned());
    parts
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct MapSource(HashMap<&'static str, &'static str>);

    impl ComputedStyleSource for MapSource {
        fn computed_property(&self, property: &str) -> Option<String> {
            self.0.get(property).map(|value| (*value).to_owned())
        }
    }

    #[test]
    fn parses_resolved_box_flex_and_viewport_values() {
        let mut values = HashMap::new();
        for (property, value) in [
            ("display", "flex"),
            ("box-sizing", "border-box"),
            ("width", "50vw"),
            ("height", "100px"),
            ("min-width", "0px"),
            ("min-height", "0px"),
            ("max-width", "none"),
            ("max-height", "none"),
            ("margin-top", "auto"),
            ("margin-right", "8px"),
            ("margin-bottom", "0px"),
            ("margin-left", "10%"),
            ("padding-top", "4px"),
            ("padding-right", "4px"),
            ("padding-bottom", "4px"),
            ("padding-left", "4px"),
            ("border-top-width", "1px"),
            ("border-right-width", "1px"),
            ("border-bottom-width", "1px"),
            ("border-left-width", "1px"),
            ("row-gap", "0px"),
            ("column-gap", "0px"),
            ("flex-direction", "row"),
            ("flex-wrap", "nowrap"),
            ("flex-grow", "1"),
            ("flex-shrink", "1"),
            ("flex-basis", "auto"),
            ("align-content", "normal"),
            ("align-items", "normal"),
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
        ] {
            values.insert(property, value);
        }
        let style =
            LayoutStyle::from_computed(&MapSource(values), Viewport::new(1000.0, 800.0)).unwrap();
        assert_eq!(style.size.width, Length::Px(500.0));
        assert_eq!(style.margin.left, Length::Percent(0.1));
        assert_eq!(style.flex.direction, FlexDirection::Row);
    }

    #[test]
    fn rejects_unmapped_grid_syntax_instead_of_faking_tracks() {
        assert_eq!(
            parse_grid_template(
                "repeat(3, 1fr)",
                "grid-template-columns",
                Viewport::new(1.0, 1.0)
            )
            .unwrap(),
            GridTemplate::Unsupported("repeat(3, 1fr)".to_owned())
        );
    }
}
