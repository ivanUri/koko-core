// SVGAElement — SVG <a> linking interface (feature-detect + relList on SVG anchors).

const js = @import("../../../js/js.zig");
const G = @import("Generic.zig");

pub const Anchor = G;

pub const JsApi = struct {
    pub const bridge = js.Bridge(Anchor);

    pub const Meta = struct {
        pub const name = "SVGAElement";
        pub const prototype_chain = bridge.prototypeChain();
        pub var class_id: bridge.ClassId = undefined;
    };

    pub const style = G.JsApi.style;
    pub const getBBox = G.JsApi.getBBox;
    pub const getComputedTextLength = G.JsApi.getComputedTextLength;
    pub const getSubStringLength = G.JsApi.getSubStringLength;
    pub const getNumberOfChars = G.JsApi.getNumberOfChars;
    pub const getExtentOfChar = G.JsApi.getExtentOfChar;
    pub const getStartPositionOfChar = G.JsApi.getStartPositionOfChar;
    pub const getEndPositionOfChar = G.JsApi.getEndPositionOfChar;
    pub const getRotationOfChar = G.JsApi.getRotationOfChar;
    pub const getCharNumAtPosition = G.JsApi.getCharNumAtPosition;
    pub const relList = G.JsApi.relList;
};
