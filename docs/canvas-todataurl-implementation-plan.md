# Canvas toDataURL() Implementation Plan

## Overview
Implement proper `HTMLCanvasElement.toDataURL()` support with real pixel buffer backing and image encoding to fix fingerprinting script crashes and provide runtime compatibility.

## Current State
- Canvas element exists but has no pixel buffer
- CanvasRenderingContext2D methods are stubs (noop)
- No image encoding infrastructure
- toDataURL() method is missing entirely

## Architecture Goals
- **Minimal functional rendering** (not full browser-grade)
- **Deterministic output** (consistent fingerprints)
- **Real pixel buffer** (not hardcoded strings)
- **Standards-compliant API** (matches Chromium behavior)
- **Internally consistent** (2D/WebGL/OffscreenCanvas alignment)

## Core Principle

**Absolute priority**: Build a real backing buffer with deterministic, internally-consistent rendering.

**NEVER**:
- Hardcoded hashes or fingerprint values
- Site-specific hacks or domain-based logic
- Fake static outputs

**ALWAYS**:
- Real pixel buffer operations
- Deterministic behavior (same input = same output)
- Internal consistency (drawImage ↔ getImageData ↔ toDataURL)
- Avoid impossible states that fingerprint scripts detect

This architecture is scalable and maintainable for Velora long-term.

## Implementation Phases

### Phase 1: Foundation (Basic infrastructure)

#### 1.1 Pixel Buffer Infrastructure
**File**: `src/core/webapi/canvas/PixelBuffer.zig`

```zig
pub const PixelBuffer = struct {
    width: u32,
    height: u32,
    pixels: []u8, // RGBA format, 4 bytes per pixel
    allocator: std.mem.Allocator,
    
    pub fn init(width: u32, height: u32, allocator: std.mem.Allocator) !*PixelBuffer;
    pub fn deinit(self: *PixelBuffer) void;
    pub fn clear(self: *PixelBuffer, color: RGBA) void;
    pub fn setPixel(self: *PixelBuffer, x: u32, y: u32, color: RGBA) void;
    pub fn getPixel(self: *const PixelBuffer, x: u32, y: u32) RGBA;
    pub fn fillRect(self: *PixelBuffer, x: f64, y: f64, w: f64, h: f64, color: RGBA) void;
};
```

#### 1.2 PNG Encoder
**File**: `src/core/webapi/canvas/PngEncoder.zig`

**Use existing library** (stb_image_write or lodepng) - DO NOT write custom PNG encoder.

Rationale:
- Focus on runtime compatibility, not PNG optimization
- Existing libraries are battle-tested
- Deterministic output is the goal, not custom implementation

```zig
// Wrapper around stb_image_write or lodepng
pub fn encodePNG(buffer: *const PixelBuffer, allocator: std.mem.Allocator) ![]u8;
```

**Recommended**: stb_image_write (single header, easy to vendor)

#### 1.3 Base64 Encoder
Use `std.base64` from Zig standard library.

#### 1.4 Canvas Integration
**Modify**: `src/core/webapi/element/html/Canvas.zig`

```zig
const Canvas = @This();
_proto: *HtmlElement,
_cached: ?DrawingContext = null,
_pixel_buffer: ?*PixelBuffer = null, // NEW

pub fn getOrCreatePixelBuffer(self: *Canvas, frame: *Frame) !*PixelBuffer {
    if (self._pixel_buffer) |buf| return buf;
    const width = self.getWidth();
    const height = self.getHeight();
    const buf = try PixelBuffer.init(width, height, frame._page.arena);
    buf.clear(RGBA.Named.transparent);
    self._pixel_buffer = buf;
    return buf;
}

pub fn toDataURL(
    self: *Canvas,
    mime_type: ?[]const u8,
    quality: ?f64,
    frame: *Frame,
) ![]const u8 {
    const mime = mime_type orelse "image/png";
    
    // Fallback to PNG for unsupported types (Chromium behavior)
    const use_png = !std.mem.eql(u8, mime, "image/jpeg");
    
    const buffer = try self.getOrCreatePixelBuffer(frame);
    
    const encoded = if (use_png)
        try PngEncoder.encodePNG(buffer, frame.call_arena)
    else
        try JpegEncoder.encodeJPEG(buffer, quality orelse 0.92, frame.call_arena);
    
    const b64 = try std.base64.standard.Encoder.encode(frame.call_arena, encoded);
    
    return try std.fmt.allocPrint(
        frame.call_arena,
        "data:{s};base64,{s}",
        .{ if (use_png) "image/png" else "image/jpeg", b64 }
    );
}
```

Add to JsApi:
```zig
pub const toDataURL = bridge.function(Canvas.toDataURL, .{});
```

#### 1.5 Context2D Integration
**Modify**: `src/core/webapi/canvas/CanvasRenderingContext2D.zig`

```zig
const CanvasRenderingContext2D = @This();
_canvas: *Canvas,
_fill_style: color.RGBA = color.RGBA.Named.black,
_stroke_style: color.RGBA = color.RGBA.Named.black, // NEW
_line_width: f64 = 1.0, // NEW
// ... other state

pub fn fillRect(self: *CanvasRenderingContext2D, x: f64, y: f64, w: f64, h: f64, frame: *Frame) !void {
    const buffer = try self._canvas.getOrCreatePixelBuffer(frame);
    buffer.fillRect(x, y, w, h, self._fill_style);
}

pub fn clearRect(self: *CanvasRenderingContext2D, x: f64, y: f64, w: f64, h: f64, frame: *Frame) !void {
    const buffer = try self._canvas.getOrCreatePixelBuffer(frame);
    buffer.fillRect(x, y, w, h, RGBA.Named.transparent);
}

// Remove .noop flags from bridge functions
```

### Phase 2: Image Operations (BLOCKER #1 - Fix drawImage crash)

**CRITICAL PRIORITY**: The runtime is currently crashing with `c.drawImage is not a function`. This is the #1 blocker and must be fixed before text rendering.

#### 2.1 drawImage() - Canvas→Canvas ONLY (BLOCKER FIX)
**This is the immediate crash fix - highest priority.**

**Scope for Phase 2** (Minimal to fix crash):
- ✅ Canvas → Canvas copying ONLY
- ✅ **Explicit bounds clipping** (source + destination) - CRITICAL
- ✅ Deterministic pixel buffer copy
- ✅ **No out-of-bounds reads/writes** - prevents crashes and impossible states
- ✅ Deterministic truncation when clipping
- ❌ NO scaling (use 1:1 pixel copy)
- ❌ NO HTMLImageElement support (defer to Phase 5)
- ❌ NO video/ImageBitmap (defer to Phase 5)
- ❌ NO filtering/interpolation (not needed)

**Why explicit clipping is critical**: Fingerprint scripts detect:
- Out-of-bounds access (crashes or undefined behavior)
- Inconsistent behavior between calls
- Impossible pixel states

```zig
pub fn drawImage(
    self: *CanvasRenderingContext2D,
    source: DrawImageSource,
    sx: f64, sy: f64,  // Source position
    sw: ?f64, sh: ?f64, // Source dimensions (optional)
    dx: f64, dy: f64,   // Destination position
    dw: ?f64, dh: ?f64, // Destination dimensions (optional)
    frame: *Frame,
) !void {
    // Phase 2: ONLY Canvas→Canvas
    const src_canvas = switch (source) {
        .canvas => |c| c,
        else => return, // Silently ignore other sources
    };
    
    const src_buffer = try src_canvas.getOrCreatePixelBuffer(frame);
    const dst_buffer = try self._canvas.getOrCreatePixelBuffer(frame);
    
    // Explicit clipping - CRITICAL for fingerprint detection
    const src_x = @max(0, @min(@as(i32, @intFromFloat(sx)), @as(i32, @intCast(src_buffer.width))));
    const src_y = @max(0, @min(@as(i32, @intFromFloat(sy)), @as(i32, @intCast(src_buffer.height))));
    const dst_x = @max(0, @min(@as(i32, @intFromFloat(dx)), @as(i32, @intCast(dst_buffer.width))));
    const dst_y = @max(0, @min(@as(i32, @intFromFloat(dy)), @as(i32, @intCast(dst_buffer.height))));
    
    // Copy width/height with bounds checking
    const copy_w = sw orelse @as(f64, @floatFromInt(src_buffer.width - src_x));
    const copy_h = sh orelse @as(f64, @floatFromInt(src_buffer.height - src_y));
    
    // Deterministic pixel-by-pixel copy (no scaling)
    // Clip to avoid out-of-bounds
    var y: u32 = 0;
    while (y < copy_h) : (y += 1) {
        var x: u32 = 0;
        while (x < copy_w) : (x += 1) {
            const src_px = src_x + x;
            const src_py = src_y + y;
            const dst_px = dst_x + x;
            const dst_py = dst_y + y;
            
            if (src_px >= src_buffer.width or src_py >= src_buffer.height) continue;
            if (dst_px >= dst_buffer.width or dst_py >= dst_buffer.height) continue;
            
            const pixel = src_buffer.getPixel(src_px, src_py);
            dst_buffer.setPixel(dst_px, dst_py, pixel);
        }
    }
}
```

**Rationale**: 
- Fingerprint scripts detect impossible states (out-of-bounds, inconsistent behavior)
- Explicit clipping prevents crashes and undefined behavior
- Deterministic truncation is better than random behavior

#### 2.2 getImageData() - Early Implementation (HIGH PRIORITY)
**Moved up from later phase** - fingerprint scripts use this API heavily for consistency checks.

```zig
pub fn getImageData(
    self: *CanvasRenderingContext2D,
    sx: f64, sy: f64,
    sw: f64, sh: f64,
    frame: *Frame,
) !*ImageData {
    const buffer = try self._canvas.getOrCreatePixelBuffer(frame);
    
    // Clip bounds
    const x = @max(0, @as(i32, @intFromFloat(sx)));
    const y = @max(0, @as(i32, @intFromFloat(sy)));
    const w = @max(0, @as(u32, @intFromFloat(sw)));
    const h = @max(0, @as(u32, @intFromFloat(sh)));
    
    // CRITICAL: Must return Uint8ClampedArray with correct length
    const data_len = w * h * 4; // RGBA
    const data = try frame.call_arena.alloc(u8, data_len);
    
    // Copy pixels with bounds checking
    var py: u32 = 0;
    while (py < h) : (py += 1) {
        var px: u32 = 0;
        while (px < w) : (px += 1) {
            const src_x = x + px;
            const src_y = y + py;
            const idx = (py * w + px) * 4;
            
            if (src_x >= buffer.width or src_y >= buffer.height) {
                // Out of bounds = transparent black
                data[idx] = 0;
                data[idx + 1] = 0;
                data[idx + 2] = 0;
                data[idx + 3] = 0;
            } else {
                const pixel = buffer.getPixel(src_x, src_y);
                data[idx] = pixel.r;
                data[idx + 1] = pixel.g;
                data[idx + 2] = pixel.b;
                data[idx + 3] = pixel.a;
            }
        }
    }
    
    return ImageData.create(w, h, data, frame);
}
```

**CRITICAL TypedArray Requirements**:
- **Must be `Uint8ClampedArray`** (not Uint8Array)
- **Correct length**: exactly `width × height × 4` bytes
- **Clamped values**: 0-255 range enforced
- **Deterministic output**: same region = same data
- **Stable backing memory**: no random/uninitialized data

Fingerprint scripts check `data.constructor.name === 'Uint8ClampedArray'` and will detect wrong array types immediately.

#### 2.3 putImageData() - Consistency with getImageData()
**Must maintain round-trip consistency**: `putImageData(getImageData(...))` should be a no-op.

```zig
pub fn putImageData(
    self: *CanvasRenderingContext2D,
    image_data: *ImageData,
    dx: f64, dy: f64,
    frame: *Frame,
) !void {
    const buffer = try self._canvas.getOrCreatePixelBuffer(frame);
    const data = image_data.data; // Uint8ClampedArray
    
    // Copy with bounds checking
    var y: u32 = 0;
    while (y < image_data.height) : (y += 1) {
        var x: u32 = 0;
        while (x < image_data.width) : (x += 1) {
            const dst_x = @as(i32, @intFromFloat(dx)) + x;
            const dst_y = @as(i32, @intFromFloat(dy)) + y;
            
            if (dst_x < 0 or dst_y < 0) continue;
            if (dst_x >= buffer.width or dst_y >= buffer.height) continue;
            
            const idx = (y * image_data.width + x) * 4;
            const pixel = RGBA{
                .r = data[idx],
                .g = data[idx + 1],
                .b = data[idx + 2],
                .a = data[idx + 3],
            };
            buffer.setPixel(dst_x, dst_y, pixel);
        }
    }
}
```

### Phase 3: Text Rendering (Pseudo-rendering - NOT real glyph rasterization)

**Philosophy**: Fingerprint scripts check for consistency and deterministic behavior, NOT visual accuracy. Pseudo-rendering with deterministic patterns is sufficient.

#### 3.1 measureText() - Deterministic Formula (NOT constant)
**Critical**: Fingerprint scripts detect constant outputs. Must vary with input.

```zig
pub fn measureText(
    self: *CanvasRenderingContext2D,
    text: []const u8,
) TextMetrics {
    const font_size = self.parseFontSize(); // Parse from font property
    const font_family = self.parseFontFamily();
    
    // Deterministic formula - varies by input
    const family_multiplier = switch (font_family) {
        .monospace => 0.6,
        .serif => 0.55,
        .sans_serif => 0.5,
        else => 0.55,
    };
    
    // Account for character variations (not just length)
    var width: f64 = 0;
    for (text) |char| {
        const char_width = switch (char) {
            'i', 'l', 'I', '1', '.', ',', ' ' => 0.3,
            'm', 'w', 'M', 'W' => 0.8,
            else => family_multiplier,
        };
        width += font_size * char_width;
    }
    
    return .{ .width = width };
}
```

**Rationale**: 
- ✅ **NOT constant** - varies by font family, font size, and character
- ✅ **Deterministic** - same input always produces same output
- ✅ **Internally consistent** - matches fillText() behavior
- ❌ **NOT pixel-perfect** - approximate is fine
- ❌ **NOT Chromium-accurate** - close enough to avoid detection

#### 3.2 fillText() - Pseudo-Rendering (NOT real fonts)
**DO NOT attempt real glyph rasterization.** Use deterministic patterns instead.

**Critical requirement**: MUST update the pixel buffer even though it's not visually accurate. This ensures:
- toDataURL() output changes after fillText()
- getImageData() reflects the text
- drawImage() can copy the text
- No inconsistent states

Pseudo-rendering approach:
```zig
pub fn fillText(
    self: *CanvasRenderingContext2D,
    text: []const u8,
    x: f64, y: f64,
    frame: *Frame,
) !void {
    const buffer = try self._canvas.getOrCreatePixelBuffer(frame);
    const font_size = self.parseFontSize();
    
    // Pseudo-rendering: deterministic pattern based on text
    // MUST update pixel buffer (even if not visually accurate)
    
    var offset_x: f64 = x;
    for (text) |char| {
        const char_width = font_size * 0.6;
        
        // Draw deterministic rectangle pattern for each character
        // Use char code to vary the pattern
        const pattern_seed = @as(u32, char) * 31;
        
        var py: u32 = 0;
        while (py < font_size) : (py += 1) {
            var px: u32 = 0;
            while (px < char_width) : (px += 1) {
                // Deterministic pseudo-glyph pattern
                const should_draw = ((pattern_seed + px + py) % 3) != 0;
                if (should_draw) {
                    const draw_x = @as(u32, @intFromFloat(offset_x + px));
                    const draw_y = @as(u32, @intFromFloat(y + py));
                    if (draw_x < buffer.width and draw_y < buffer.height) {
                        buffer.setPixel(draw_x, draw_y, self._fill_style);
                    }
                }
            }
        }
        
        offset_x += char_width;
    }
}
```

**Key principles**:
- ✅ **Updates pixel buffer** - affects toDataURL(), getImageData(), drawImage()
- ✅ **Deterministic** - same text/position/font = same output
- ✅ **Consistent with measureText()** - width matches
- ✅ **Character-code based variation** - different chars produce different patterns
- ❌ **NOT visually accurate** - doesn't look like real text
- ❌ **NOT real glyph rendering** - no font files, no rasterization

**Why this works**: Fingerprint scripts check:
- **Output consistency** - not visual quality
- **API relationships** - measureText ↔ fillText ↔ toDataURL consistency
- **Deterministic behavior** - not rendering realism
- **State changes** - pixel buffer must actually change

They do NOT check if text looks correct visually.

### Phase 4: Canvas Resize Semantics

#### 4.1 Width/Height Setter Behavior
**Critical**: Fingerprint scripts check that setting width/height clears the canvas (Chromium behavior).

```zig
pub fn setWidth(self: *Canvas, value: u32, frame: *Frame) !void {
    const old_width = self.getWidth();
    
    // Update attribute
    const str = try std.fmt.allocPrint(frame.call_arena, "{d}", .{value});
    try self.asElement().setAttributeSafe(comptime .wrap("width"), .wrap(str), frame);
    
    // IMPORTANT: Reset pixel buffer when dimensions change
    if (old_width != value) {
        self._pixel_buffer = null; // Will be recreated on next access
    }
}
```

**Behavior**: 
- Setting `canvas.width` or `canvas.height` must **recreate the backing buffer**
- Old pixel data is **lost** (cleared)
- Context state is **reset**
- This matches Chromium behavior exactly

### Phase 5: WebGL Consistency Layer

**Core principle**: **Consistency > Realism**

The goal is NOT to implement real GPU rendering. The goal is internally consistent behavior that doesn't expose impossible states.

#### 5.1 WebGL Pixel Buffer
**Goal**: Internally consistent behavior, NOT GPU-accurate rendering.

**DO NOT implement** (not needed for fingerprint compatibility):
- ❌ Real GPU rendering pipeline
- ❌ Shader compilation/execution
- ❌ Texture filtering/mipmapping
- ❌ Depth/stencil buffers
- ❌ Realistic lighting/shading
- ❌ Geometry processing

**DO implement** (required for consistency):
- ✅ **Consistent pixel state** - buffer reflects API calls
- ✅ **Deterministic framebuffer** - same operations = same pixels
- ✅ **readPixels ↔ toDataURL consistency** - CRITICAL
- ✅ **No impossible states** - no alpha > 255, no NaN pixels, etc.
- ✅ **Bounds checking** - prevent out-of-bounds access

**Why this works**: Fingerprint scripts detect inconsistencies and impossible states, NOT rendering quality.

```zig
// WebGLRenderingContext gets a pixel buffer
_pixel_buffer: ?*PixelBuffer = null,

pub fn readPixels(
    self: *WebGLRenderingContext,
    x: i32, y: i32, width: i32, height: i32,
    format: u32, type: u32,
    pixels: js.TypedArray,
) !void {
    const buffer = try self.getOrCreatePixelBuffer();
    
    // CRITICAL: Must return Uint8Array (not Uint8ClampedArray for WebGL)
    // Must match pixel buffer state
    
    // Copy with bounds checking
    var py: u32 = 0;
    while (py < height) : (py += 1) {
        var px: u32 = 0;
        while (px < width) : (px += 1) {
            const src_x = x + px;
            const src_y = y + py;
            const idx = (py * width + px) * 4;
            
            if (src_x < 0 or src_y < 0 or 
                src_x >= buffer.width or src_y >= buffer.height) {
                pixels[idx] = 0;
                pixels[idx + 1] = 0;
                pixels[idx + 2] = 0;
                pixels[idx + 3] = 0;
            } else {
                const pixel = buffer.getPixel(src_x, src_y);
                pixels[idx] = pixel.r;
                pixels[idx + 1] = pixel.g;
                pixels[idx + 2] = pixel.b;
                pixels[idx + 3] = pixel.a;
            }
        }
    }
}

pub fn clear(self: *WebGLRenderingContext, mask: u32) !void {
    const buffer = try self.getOrCreatePixelBuffer();
    
    // Simple clear - deterministic behavior
    if (mask & GL_COLOR_BUFFER_BIT != 0) {
        buffer.clear(self._clear_color);
    }
    // Ignore depth/stencil for now
}
```

**Key principle**: 
- **WebGL draw operations can be stubs** - drawArrays(), drawElements() can be no-ops
- **Pixel buffer must remain internally consistent** - clear() must actually clear
- **readPixels() must match toDataURL()** - CRITICAL for fingerprint detection
- **No "impossible" states** - alpha > 255, negative values, NaN, etc.
- **Deterministic behavior** - same sequence of calls = same output

#### 5.2 WebGL toDataURL() Consistency
**Critical**: Fingerprint scripts detect inconsistencies.

```zig
// WebGL canvas uses same toDataURL as 2D canvas
// Pixel buffer is shared infrastructure
// readPixels() and toDataURL() MUST return consistent data
```

**Test for consistency**:
```javascript
const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl');

// Clear to red
gl.clearColor(1, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);

// Check consistency
const pixels = new Uint8Array(4);
gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

const dataURL = canvas.toDataURL();
// Decode dataURL and check pixel at (0,0) matches pixels array

assert(pixels[0] === 255); // Red
assert(pixels[1] === 0);   // Green
assert(pixels[2] === 0);   // Blue
assert(pixels[3] === 255); // Alpha
```

**Rationale**: Fingerprint scripts detect:
- **Inconsistencies** between APIs (not rendering realism)
- **Impossible states** like out-of-range values (not visual quality)
- **Broken relationships** between readPixels/toDataURL (not GPU accuracy)
- **Non-deterministic behavior** (not performance)

They do NOT check if WebGL rendering looks correct.

### Phase 6: JPEG Support (Lower priority)

#### 6.1 JPEG Encoder
**File**: `src/core/webapi/canvas/JpegEncoder.zig`

**Only if actually needed** - many fingerprint scripts only use PNG.

- Use stb_image_write for JPEG too
- Support quality parameter
- Convert RGBA to RGB (drop alpha channel)

**Check first**: Do fingerprint scripts actually call toDataURL('image/jpeg')?
If not, defer this phase.

## Dependencies

### External Libraries (Optional)
- **stb_image_write**: C library for PNG/JPEG encoding (can be vendored)
- **miniz**: Deflate compression for PNG
- Or use Zig's std.compress.deflate

### Zig Standard Library
- `std.base64`: Base64 encoding
- `std.compress.deflate`: PNG compression
- `std.mem.Allocator`: Memory management
- `std.fmt`: String formatting

## Testing Strategy

### Unit Tests
```zig
test "PixelBuffer: create and clear" { }
test "PixelBuffer: fillRect" { }
test "PNG encoder: empty canvas" { }
test "PNG encoder: single color" { }
test "PNG encoder: pattern" { }
```

### Integration Tests
```javascript
// Empty canvas
const canvas = document.createElement('canvas');
const dataURL = canvas.toDataURL();
assert(dataURL.startsWith('data:image/png;base64,'));

// Filled rectangle
const ctx = canvas.getContext('2d');
ctx.fillStyle = 'red';
ctx.fillRect(10, 10, 50, 50);
const dataURL2 = canvas.toDataURL();
assert(dataURL2 !== dataURL); // Different from empty

// JPEG format
const jpegURL = canvas.toDataURL('image/jpeg', 0.8);
assert(jpegURL.startsWith('data:image/jpeg;base64,'));

// Repeated calls
const url1 = canvas.toDataURL();
const url2 = canvas.toDataURL();
assert(url1 === url2); // Deterministic

// WebGL canvas
const glCanvas = document.createElement('canvas');
const gl = glCanvas.getContext('webgl');
const glURL = glCanvas.toDataURL();
assert(glURL.startsWith('data:image/png;base64,'));
```

## Implementation Order (REVISED - Blocker-First Priority)

### Phase 1: Foundation (Basic infrastructure - ~400-600 lines, 3-5 hours)
1. **PixelBuffer.zig** (~150 lines)
   - Core RGBA buffer with explicit bounds checking
   - setPixel/getPixel with range validation
   - fillRect with clipping
   - clear() operation
2. **PngEncoder.zig** (~50 lines)
   - Wrapper around stb_image_write (already vendored)
   - encodePNG() function
3. **Canvas.toDataURL()** (~100 lines)
   - Main API with PNG export
   - Base64 encoding
   - MIME type handling (fallback to PNG)
   - Function.prototype.toString compatibility
4. **Context2D.fillRect()** (~50 lines)
   - Basic rectangle rendering with bounds checking
5. **Context2D.clearRect()** (~50 lines)
   - Clear operation (fill with transparent)
6. **Canvas resize semantics** (~50 lines)
   - Buffer recreation on width/height change
   - Clear old pixel data
7. **Tests** (~150 lines)
   - Verify basic functionality

### Phase 2: Image Operations (BLOCKER #1 - Fix drawImage crash - ~400-500 lines, 3-5 hours)
8. **Context2D.drawImage()** (~200 lines) - **HIGHEST PRIORITY**
   - Canvas→Canvas ONLY (no HTMLImageElement yet)
   - **Explicit bounds clipping** (source + destination)
   - Deterministic pixel-by-pixel copy
   - **No out-of-bounds reads/writes**
   - No scaling (1:1 copy only)
   - No filtering/interpolation
   - **Fix `c.drawImage is not a function` crash**
9. **Context2D.getImageData()** (~100 lines) - **HIGH PRIORITY**
   - Return **Uint8ClampedArray** with correct length
   - Explicit bounds checking
   - Deterministic output
   - Out-of-bounds = transparent black
10. **Context2D.putImageData()** (~100 lines)
    - Consistency with getImageData()
    - Round-trip test: put(get(x)) should be no-op
11. **TypedArray semantics verification** (~100 lines)
    - Ensure Uint8ClampedArray (not Uint8Array)
    - Correct length calculation
    - Proper clamping (0-255)
    - Tests for consistency

### Phase 3: Text Rendering (Pseudo-rendering - ~300-400 lines, 2-4 hours)
12. **Context2D.measureText()** (~100 lines)
    - Deterministic formula (NOT constant)
    - Vary by font family (serif/sans-serif/monospace)
    - Vary by character (i/l vs m/w)
    - Vary by font size
    - Consistent with fillText
13. **Context2D.fillText()** (~150 lines)
    - Pseudo-rendering with deterministic patterns
    - Character-code-based pixel modifications
    - **MUST update pixel buffer**
    - Consistent with measureText width
    - NOT real glyph rasterization
14. **Font parsing** (~100 lines)
    - Extract size from font property
    - Extract family from font property
    - Handle common formats

### Phase 4: WebGL Consistency Layer (~200-300 lines, 2-3 hours)
15. **WebGL pixel buffer** (~100 lines)
    - Shared infrastructure with 2D canvas
    - Same PixelBuffer backing
16. **WebGL.readPixels()** (~100 lines)
    - Read from buffer (Uint8Array for WebGL, not Uint8ClampedArray)
    - Bounds checking
    - Consistency with toDataURL()
17. **WebGL.clear()** (~50 lines)
    - Simple deterministic clear
    - Update pixel buffer
18. **WebGL toDataURL() consistency** (verification)
    - Ensure readPixels ↔ toDataURL match
    - Test for impossible states

### Phase 5: Advanced (Lower priority - ~200-300 lines, 2-4 hours if needed)
19. **JPEG encoder** (~100 lines)
    - Only if fingerprint scripts actually use it
    - Use stb_image_write for JPEG
    - Quality parameter support
20. **HTMLImageElement support for drawImage** (~100 lines)
    - If needed for specific fingerprint checks
21. **Path rendering** (~100 lines)
    - stroke(), fill() for paths
    - If needed for specific checks
22. **Advanced compositing** (~100 lines)
    - globalCompositeOperation modes
    - If needed for specific checks

**Total Estimated**: ~1500-2100 lines, 12-21 hours

## Estimated Complexity (REVISED)

- **Phase 1 (Foundation)**: ~400-600 lines, 3-5 hours
  - PixelBuffer: ~150 lines
  - PNG wrapper: ~50 lines (using stb_image_write)
  - Canvas.toDataURL(): ~100 lines
  - fillRect/clearRect: ~100 lines
  - Resize semantics: ~50 lines
  - Tests: ~150 lines

- **Phase 2 (Image Ops - BLOCKER FIX)**: ~400-500 lines, 3-5 hours
  - **drawImage (canvas→canvas with explicit clipping)**: ~200 lines - **CRITICAL**
  - **getImageData (Uint8ClampedArray with bounds checking)**: ~100 lines - **HIGH PRIORITY**
  - putImageData (consistency with getImageData): ~100 lines
  - TypedArray semantics verification: ~100 lines

- **Phase 3 (Text Pseudo-Rendering)**: ~300-400 lines, 2-4 hours
  - measureText (deterministic formula, NOT constant): ~100 lines
  - fillText (pseudo-rendering with buffer updates): ~150 lines
  - Font parsing (size + family extraction): ~100 lines

- **Phase 4 (WebGL Consistency Layer)**: ~200-300 lines, 2-3 hours
  - WebGL pixel buffer (shared with 2D): ~100 lines
  - readPixels (Uint8Array, consistency with toDataURL): ~100 lines
  - clear (deterministic buffer update): ~50 lines

- **Phase 5 (Advanced)**: ~200-300 lines, 2-4 hours (if needed)
  - JPEG encoder: ~100 lines
  - Path rendering: ~100 lines
  - Advanced compositing: ~100 lines

**Total**: ~1500-2100 lines, 12-21 hours

## Risks and Mitigations (Updated)

### Risk: PNG encoding complexity
**Mitigation**: ✅ Use stb_image_write (DECIDED - do not write custom encoder)

### Risk: Rendering accuracy
**Mitigation**: ✅ Focus on deterministic + internally consistent output, not pixel-perfect accuracy

### Risk: measureText() detection
**Mitigation**: ✅ Use formula-based approach, not constant values. Deterministic but varies with input.

### Risk: Performance
**Mitigation**: Keep buffers small, lazy initialization, efficient algorithms

### Risk: Memory usage
**Mitigation**: Use arena allocators, clear buffers on resize, limit max canvas size

### Risk: Fingerprint-specific hacks creeping in
**Mitigation**: ✅ Maintain principle: real backing buffer + deterministic rendering. No domain-specific code. No hardcoded hashes. No site-specific logic.

### Risk: WebGL complexity
**Mitigation**: ✅ Focus on consistency, not realistic GPU rendering. Stub operations are fine if internally consistent. readPixels ↔ toDataURL must match.

### Risk: Out-of-bounds crashes
**Mitigation**: ✅ Explicit bounds checking in all pixel operations. Deterministic clipping behavior. No undefined behavior.

### Risk: TypedArray detection
**Mitigation**: ✅ Use correct array types (Uint8ClampedArray for 2D, Uint8Array for WebGL). Correct lengths. Proper clamping.

## Success Criteria (Comprehensive)

### Basic Functionality
1. ✅ `canvas.toDataURL()` returns valid data URL with correct format
2. ✅ Empty canvas produces consistent, deterministic output
3. ✅ fillRect() changes toDataURL() output (pixel buffer updates)
4. ✅ Repeated calls produce identical results (deterministic)
5. ✅ MIME type handling matches Chromium (fallback to PNG)

### Critical Blockers Fixed
6. ✅ **drawImage() works** - no more `c.drawImage is not a function` crash
7. ✅ **getImageData() returns Uint8ClampedArray** with correct length
8. ✅ **TypedArray correctness** - proper clamping, no uninitialized data
9. ✅ **Bounds checking** - no out-of-bounds crashes or undefined behavior

### Consistency Requirements
10. ✅ **Resize semantics** - setting width/height clears canvas
11. ✅ **Repeated deterministic rendering** - same operations = same output
12. ✅ **No impossible states** - no alpha > 255, no NaN, no negative values
13. ✅ **API consistency** - drawImage ↔ getImageData ↔ toDataURL alignment
14. ✅ **WebGL consistency** - readPixels ↔ toDataURL match

### Runtime Compatibility
15. ✅ **No fingerprint script crashes** - all APIs callable without errors
16. ✅ **WebGL canvas supports toDataURL()** - same infrastructure as 2D
17. ✅ **Function.prototype.toString** compatibility for toDataURL
18. ✅ **toDataURL.length** property matches Chromium

### NOT Required (Explicitly)
- ❌ Pixel-perfect rendering accuracy
- ❌ Visual quality of text rendering
- ❌ Real GPU shader execution
- ❌ Perfect Chromium metric matching

## Next Steps (Updated - Blocker-First Approach)

1. ✅ Plan reviewed and approved
2. ✅ PNG encoder approach decided: Use stb_image_write
3. ✅ **Implementation order revised**: drawImage() moved to Phase 2 (BLOCKER #1)
4. ✅ **getImageData() moved to Phase 2**: Heavily used by fingerprint scripts
5. **Start Phase 1 implementation** (Foundation):
   - Vendor stb_image_write.h (already done)
   - Create PixelBuffer.zig with bounds checking
   - Implement fillRect/clearRect with real buffer
   - Add toDataURL() with PNG export
   - Add resize semantics (buffer recreation)
6. **Phase 2 implementation** (CRITICAL - Fix drawImage crash):
   - Implement drawImage() canvas→canvas with explicit clipping
   - Implement getImageData() with Uint8ClampedArray
   - Implement putImageData() for consistency
   - Ensure TypedArray semantics are correct
7. **Phase 3 implementation** (Text pseudo-rendering):
   - measureText() with deterministic formula
   - fillText() with pseudo-rendering patterns
8. **Test against fingerprint scripts** after each phase
9. **Iterate based on real-world detection**

## Key Principles (Reinforced - CRITICAL)

### Architecture Principles
1. ✅ **Real backing buffer** - not hardcoded strings or fake outputs
2. ✅ **Deterministic output** - same input = same output, always
3. ✅ **Internally consistent** - readPixels ↔ toDataURL ↔ drawImage ↔ getImageData alignment
4. ✅ **No fingerprint-specific hacks** - general solution only, no domain-based logic
5. ✅ **Use existing libraries** - stb_image_write for encoding, don't reinvent PNG

### Implementation Priorities
6. ✅ **Consistency > Realism** - internally consistent behavior beats visual accuracy
7. ✅ **Avoid impossible states** - no out-of-bounds, no alpha > 255, no NaN
8. ✅ **Explicit bounds checking** - prevent crashes and undefined behavior
9. ✅ **Deterministic truncation** - when clipping, behavior must be predictable

### Scope Management
10. ✅ **Canvas→Canvas first** - simplest drawImage case, covers many fingerprint checks
11. ✅ **Pseudo-rendering for text** - deterministic patterns, not real glyph rasterization
12. ✅ **WebGL consistency > GPU accuracy** - consistent pixel state, not realistic rendering
13. ✅ **Approximate is fine** - measureText doesn't need pixel-perfect Chromium metrics

### What to NEVER Do
14. ❌ **NO hardcoded hashes** - defeats the purpose of real rendering
15. ❌ **NO site-specific hacks** - not scalable or maintainable
16. ❌ **NO domain-based logic** - breaks the abstraction
17. ❌ **NO fake static outputs** - fingerprint scripts will detect this

This architecture is the foundation for Velora's long-term fingerprint compatibility.

## References

- [MDN: HTMLCanvasElement.toDataURL()](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL)
- [PNG Specification](http://www.libpng.org/pub/png/spec/1.2/PNG-Contents.html)
- [Canvas API Specification](https://html.spec.whatwg.org/multipage/canvas.html)
- [stb_image_write](https://github.com/nothings/stb/blob/master/stb_image_write.h)
