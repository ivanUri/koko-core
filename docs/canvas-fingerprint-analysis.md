# Canvas Fingerprint Analysis

## Problem Statement

CreepJS detects:
```
rendering: 16% rgba noise
Canvas 2d: lies
```

## Root Cause Analysis

### What CreepJS is Testing

CreepJS runs canvas fingerprint tests by:
1. Rendering the same content multiple times
2. Calling `getImageData()` to extract pixels
3. Comparing pixel data between runs
4. If pixels differ → marks as "noise" or "lies"

### Current Velora Behavior

From code inspection:
- `PixelBuffer.zig`: Stores RGBA pixels deterministically
- `PngEncoder.zig`: Has test "deterministic output" - proves no random noise
- `fillRect()`: Implements proper alpha blending
- `getImageData()`: Currently returns empty/zero data

**The issue is NOT random noise addition.**

**The issue is Canvas rendering is incomplete:**
- Text rendering not implemented
- getImageData() not properly extracting pixel data
- Rendering operations may have state bugs

### What CreepJS Expects

Real browsers:
1. Same input → same pixels (100% deterministic)
2. getImageData() returns actual rendered pixels
3. toDataURL() encodes actual rendered content

## Current Implementation Gaps

### 1. getImageData() - CRITICAL

Located in: `src/core/webapi/canvas/CanvasRenderingContext2D.zig`

```zig
pub fn getImageData(
    _: *const CanvasRenderingContext2D,
    _x: i32,
    _y: i32,
    _width: i32,
    _height: i32,
    exec: *Execution,
) !*ImageData {
    // Currently creates empty ImageData
    // Does NOT extract actual pixel data from PixelBuffer
}
```

**Fix needed:**
- Extract pixels from `self._canvas._pixel_buffer`
- Copy rect region to ImageData
- Handle bounds checking

### 2. Text Rendering - HIGH PRIORITY

Currently:
- `fillText()`, `strokeText()` are noop
- Text metrics implemented (Phase 1 complete)
- But NO actual text rasterization

**Options:**
A. **Deterministic heuristic rendering** (recommended for Phase 1)
   - Fill bounding box with solid color based on text hash
   - Deterministic per text content
   - Fast, no font system needed
   
B. Font rasterization (Phase 2)
   - Requires font loading
   - Complex, slow
   - Overkill for fingerprint resistance

### 3. Image Rendering

- `drawImage()` not implemented
- CreepJS may test image rendering

## Solution Strategy

### Phase 1: Make Canvas Deterministic (P0)

**Goal:** Same operations → same pixels, every time

**Changes needed:**

1. **Fix getImageData()**
   ```zig
   pub fn getImageData(...) !*ImageData {
       const buffer = self._canvas._pixel_buffer orelse {
           // Return empty ImageData if no buffer
       };
       
       // Extract rect region from buffer
       // Copy to ImageData.data
       // Handle clipping, bounds
   }
   ```

2. **Implement deterministic text rendering**
   ```zig
   pub fn fillText(self: *CanvasRenderingContext2D, text: []const u8, x: f64, y: f64, ...) {
       // Use TextMetrics to get bbox
       const metrics = measureText(text);
       
       // Fill bbox with color derived from:
       //   - text content hash
       //   - fillStyle color
       //   - font properties
       // Result must be deterministic!
       
       fillRect(x, y, metrics.width, font_size, self._fill_style);
   }
   ```

3. **Profile-based fingerprint** (longer term)
   - Store canvas fingerprint hash in profile config
   - On first render: compute hash, store it
   - On subsequent renders: return cached hash
   - This mimics real browser behavior

### Phase 2: Real Rendering (Future)

- Font system integration
- Proper text rasterization
- Image decoding
- Path rendering

## Immediate Action Plan

1. ✅ TextMetrics heuristic (completed)
2. 🔴 Fix getImageData() to extract real pixels
3. 🔴 Implement deterministic fillText()/strokeText()
4. 🔴 Verify with CreepJS
5. ⚪ Add profile-based caching (optional)

## Testing Strategy

```javascript
// Test deterministic behavior
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');

// Render same content twice
function render() {
    ctx.fillStyle = 'red';
    ctx.fillRect(10, 10, 50, 50);
    ctx.fillStyle = 'black';
    ctx.fillText('test', 20, 30);
    return ctx.getImageData(0, 0, 100, 100);
}

const data1 = render();
const data2 = render();

// Must be identical
assert(data1.data.every((v, i) => v === data2.data[i]));
```

## Notes

- NO random noise should be added
- Deterministic ≠ realistic (that's okay for now)
- Focus: consistent, not accurate
- Profile caching can come later
