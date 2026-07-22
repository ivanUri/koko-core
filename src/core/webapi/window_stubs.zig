// Minimal window constructor stubs for CreepJS blinkWindow version detection (v94–v115).
// Each type must exist on window with [native code] toString and matching prototype.constructor.name.

const js = @import("../js/js.zig");

fn stubInterface(comptime interface_name: []const u8) type {
    return struct {
        const Self = @This();
        _pad: bool = false,

        pub const JsApi = struct {
            pub const bridge = js.Bridge(Self);

            pub const Meta = struct {
                pub const name = interface_name;
                pub const prototype_chain = bridge.prototypeChain();
                pub var class_id: bridge.ClassId = undefined;
                pub const empty_with_no_proto = true;
            };
        };
    };
}

// Intentionally omit CanvasFilter (v99) so v113–115 (!CanvasFilter) can match.
// Intentionally omit ContentIndex — Chrome macOS has no window.ContentIndex.
const names = [_][]const u8{
    // CreepJS headless platform estimate (macOS Chrome)
    "BarcodeDetector",
    "EyeDropper",
    "FileSystemWritableFileStream",
    "HIDDevice",
    "SerialPort",
    // v94
    "AudioData",
    "AudioDecoder",
    "AudioEncoder",
    "EncodedAudioChunk",
    "EncodedVideoChunk",
    "IdleDetector",
    "ImageDecoder",
    "ImageTrack",
    "ImageTrackList",
    "VideoColorSpace",
    "VideoDecoder",
    "VideoEncoder",
    "VideoFrame",
    "MediaStreamTrackGenerator",
    "MediaStreamTrackProcessor",
    "Profiler",
    "VirtualKeyboard",
    "DelegatedInkTrailPresenter",
    "Ink",
    "TaskPriorityChangeEvent",
    "VirtualKeyboardGeometryChangeEvent",
    // v95–96
    "URLPattern",
    // v97–98
    "WebTransport",
    "WebTransportBidirectionalStream",
    "WebTransportDatagramDuplexStream",
    "WebTransportError",
    // v100
    "CSSMathClamp",
    // v99–100
    "CSSLayerBlockRule",
    "CSSLayerStatementRule",
    // v101–104
    "CSSFontPaletteValuesRule",
    // v105–106
    "CSSContainerRule",
    // v107–108
    "XRCamera",
    // v109
    "MathMLElement",
    // v110
    "AudioSinkInfo",
    // v111–115
    "ViewTransition",
    // CreepJS features (blinkWindow v72–v93) — in window-keys baseline, not full bridge types
    "FeaturePolicy",
    "FragmentDirective",
    "PeriodicSyncManager",
    "VideoPlaybackQuality",
    "WakeLock",
    "WakeLockSentinel",
    "AnimationPlaybackEvent",
    "AnimationTimeline",
    "CSSAnimation",
    "CSSTransition",
    "DocumentTimeline",
    "LayoutShiftAttribution",
    "CSSPropertyRule",
    "CookieChangeEvent",
    "CookieStoreManager",
    "ReadableByteStreamController",
    "ReadableStreamBYOBReader",
    "ReadableStreamBYOBRequest",
    "CustomStateSet",
    "CSSCounterStyleRule",
    "GravitySensor",
    "NavigatorManagedData",
    "RTCEncodedAudioFrame",
    "RTCEncodedVideoFrame",
    "XRHitTestResult",
    "XRHitTestSource",
    "XRRay",
    "XRTransientInputHitTestResult",
    "XRTransientInputHitTestSource",
    "XRDOMOverlayState",
    "XRSystem",
    "XRLayer",
    "XRAnchor",
    "XRAnchorSet",
    "XRWebGLBinding",
    "XRCPUDepthInformation",
    "XRDepthInformation",
    "XRLightEstimate",
    "XRLightProbe",
    "XRWebGLDepthInformation",
};

pub fn registerTypes() []const type {
    comptime var result: [names.len]type = undefined;
    inline for (names, 0..) |name, i| {
        result[i] = stubInterface(name);
    }
    return &result;
}
