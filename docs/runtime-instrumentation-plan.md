# Runtime Instrumentation Implementation Plan

## Phase: Runtime Semantic Debugging

The runtime has moved beyond "missing APIs" into **runtime semantics + binding correctness** phase.

Current errors indicate failures in:
- Unexpected null generation
- WebIDL conversion/overload resolution
- Canvas/ImageData allocation
- TypedArray invariants
- Microtask queue management

## Implementation Priorities

### Priority 1: Unexpected Null Generation Tracing

**Target:** Identify APIs returning `null` when Chrome returns object/string/function/undefined

**Implementation Location:** `src/core/js/Local.zig`

**Changes Required:**

```zig
// Add to Local.zig after line 480 (in zigValueToJs)
.optional => {
    if (value) |v| {
        return self.zigValueToJs(v, opts);
    }
    
    // INSTRUMENTATION: Track null returns
    if (comptime @import("builtin").mode == .Debug) {
        if (opts.track_null_returns) {
            log.warn(.js_binding, "API returned null", .{
                .type = @typeName(T),
                .caller_type = opts.caller_type orelse "unknown",
                .caller_func = opts.caller_func orelse "unknown",
                .stack = self.stackTrace() catch "no stack",
            });
        }
    }
    
    // Return undefined for null optionals (Chrome behavior)
    return .{ .local = self, .handle = self.isolate.initUndefined() };
},
```

**Add to CallOpts in Caller.zig:**

```zig
pub const CallOpts = struct {
    // ... existing fields ...
    
    /// Track when APIs return null (debug only)
    track_null_returns: bool = true,
    
    /// Caller type name for logging
    caller_type: ?[]const u8 = null,
    
    /// Caller function name for logging
    caller_func: ?[]const u8 = null,
};
```

**Instrument key API return paths:**

- Navigator properties (plugins, mimeTypes, userAgent)
- Canvas methods (getContext, toDataURL, getImageData)
- Crypto APIs (randomUUID, getRandomValues, subtle)
- Storage APIs (estimate, persist)

### Priority 2: Overload Resolution Tracing

**Target:** Identify `invalid argument` errors from overload mismatches

**Implementation Location:** `src/core/js/Caller.zig`

**Changes Required:**

Add before line 839 (parameter mapping):

```zig
// INSTRUMENTATION: Log overload resolution attempts
if (comptime @import("builtin").mode == .Debug) {
    if (js_parameter_count != params_to_map.len) {
        log.debug(.js_binding, "overload parameter count mismatch", .{
            .type = @typeName(T),
            .func = @typeName(F),
            .expected = params_to_map.len,
            .actual = js_parameter_count,
            .overload_index = overload_idx,
        });
    }
}
```

Add in parameter conversion loop (around line 850):

```zig
const js_val = info.getArg(@intCast(i), local);
const zig_val = local.jsValueToZig(param.type, js_val) catch |err| {
    // INSTRUMENTATION: Log conversion failures
    if (comptime @import("builtin").mode == .Debug) {
        log.warn(.js_binding, "parameter conversion failed", .{
            .type = @typeName(T),
            .func = @typeName(F),
            .param_index = i,
            .param_type = @typeName(param.type),
            .js_type = js_val.typeOf(),
            .err = err,
            .stack = local.stackTrace() catch "no stack",
        });
    }
    return err;
};
```

### Priority 3: Canvas/ImageData Allocation Validation

**Target:** Prevent fake OOM from bad dimension conversions

**Implementation Location:** `src/core/webapi/canvas/PixelBuffer.zig`

**Changes Required:**

```zig
pub fn init(allocator: std.mem.Allocator, width: u32, height: u32) !PixelBuffer {
    // VALIDATION: Check for suspicious dimensions
    if (width == 0 or height == 0) {
        log.err(.canvas, "PixelBuffer.init: zero dimension", .{
            .width = width,
            .height = height,
        });
        return error.InvalidArgument;
    }
    
    if (width > 32768 or height > 32768) {
        log.err(.canvas, "PixelBuffer.init: dimension too large", .{
            .width = width,
            .height = height,
        });
        return error.RangeError;
    }
    
    // VALIDATION: Check for overflow
    const max_pixels: u64 = 268435456; // 16384 * 16384
    const total_pixels: u64 = @as(u64, width) * @as(u64, height);
    if (total_pixels > max_pixels) {
        log.err(.canvas, "PixelBuffer.init: too many pixels", .{
            .width = width,
            .height = height,
            .total_pixels = total_pixels,
        });
        return error.OutOfMemory;
    }
    
    const size = @as(usize, width) * @as(usize, height) * 4;
    
    // INSTRUMENTATION: Log allocations (debug only)
    if (comptime @import("builtin").mode == .Debug) {
        log.debug(.canvas, "PixelBuffer.init", .{
            .width = width,
            .height = height,
            .size = size,
            .size_mb = @as(f64, @floatFromInt(size)) / (1024.0 * 1024.0),
        });
    }
    
    const data = try allocator.alloc(u8, size);
    
    return PixelBuffer{
        .width = width,
        .height = height,
        .data = data,
    };
}
```

**Implementation Location:** `src/core/webapi/canvas/CanvasRenderingContext2D.zig`

Add to getImageData:

```zig
pub fn getImageData(
    self: *CanvasRenderingContext2D,
    sx: i32,
    sy: i32,
    sw: i32,
    sh: i32,
    frame: *Frame,
) !*ImageData {
    // VALIDATION: Check dimensions before conversion
    if (sw <= 0 or sh <= 0) {
        log.err(.canvas, "getImageData: invalid dimensions", .{
            .sw = sw,
            .sh = sh,
        });
        return error.InvalidArgument;
    }
    
    // VALIDATION: Check for overflow
    if (sw > std.math.maxInt(u32) or sh > std.math.maxInt(u32)) {
        log.err(.canvas, "getImageData: dimensions too large", .{
            .sw = sw,
            .sh = sh,
        });
        return error.RangeError;
    }
    
    const width: u32 = @intCast(sw);
    const height: u32 = @intCast(sh);
    
    // INSTRUMENTATION: Log getImageData calls
    if (comptime @import("builtin").mode == .Debug) {
        log.debug(.canvas, "getImageData", .{
            .sx = sx,
            .sy = sy,
            .sw = sw,
            .sh = sh,
            .width = width,
            .height = height,
            .canvas_width = self.canvas.width,
            .canvas_height = self.canvas.height,
        });
    }
    
    return ImageData.create(width, height, frame);
}
```

### Priority 4: TypedArray Invariant Assertions

**Target:** Ensure TypedArray semantics match Chrome

**Implementation Location:** `src/core/js/Local.zig` (createTypedArray)

**Changes Required:**

```zig
pub fn createTypedArray(self: *const Local, comptime array_type: js.ArrayType, size: usize) js.ArrayBufferRef(array_type) {
    // VALIDATION: Check size limits
    const element_size = switch (array_type) {
        .int8, .uint8, .uint8_clamped => 1,
        .int16, .uint16, .float16 => 2,
        .int32, .uint32, .float32 => 4,
        .float64 => 8,
    };
    
    const byte_length = size * element_size;
    
    // VALIDATION: Check for overflow
    if (byte_length > std.math.maxInt(u32)) {
        log.err(.js_binding, "TypedArray: byte_length overflow", .{
            .array_type = @tagName(array_type),
            .size = size,
            .element_size = element_size,
            .byte_length = byte_length,
        });
        @panic("TypedArray byte_length overflow");
    }
    
    const result = js.ArrayBufferRef(array_type).init(self, size);
    
    // ASSERTION: Verify invariants (debug only)
    if (comptime @import("builtin").mode == .Debug) {
        const actual_length = result.length();
        const actual_byte_length = result.byteLength();
        
        if (actual_length != size) {
            log.err(.js_binding, "TypedArray: length mismatch", .{
                .expected = size,
                .actual = actual_length,
            });
        }
        
        if (actual_byte_length != byte_length) {
            log.err(.js_binding, "TypedArray: byteLength mismatch", .{
                .expected = byte_length,
                .actual = actual_byte_length,
            });
        }
    }
    
    return result;
}
```

### Priority 5: Microtask Scheduler Tracing

**Target:** Identify microtask reentry issues

**Implementation Location:** `src/runtime/RealmLifecycleKernel.zig`

**Changes Required:**

```zig
// Add checkpoint depth tracking
checkpoint_depth: u32 = 0,

pub fn checkpointMicrotasks(self: *RealmLifecycleKernel) !void {
    // VALIDATION: Detect reentry
    if (self.checkpoint_depth > 0) {
        log.err(.microtask, "microtask.checkpoint.reentry_rejected", .{
            .frame_id = self.frame_id,
            .current_epoch = self.current_epoch,
            .realm_state = @tagName(self.realm_state),
            .checkpoint_depth = self.checkpoint_depth,
        });
        return error.MicrotaskReentry;
    }
    
    self.checkpoint_depth += 1;
    defer self.checkpoint_depth -= 1;
    
    // INSTRUMENTATION: Log checkpoint
    if (comptime @import("builtin").mode == .Debug) {
        log.debug(.microtask, "checkpoint.enter", .{
            .frame_id = self.frame_id,
            .pending_count = self.pending_microtasks.items.len,
        });
    }
    
    // ... existing checkpoint logic ...
    
    if (comptime @import("builtin").mode == .Debug) {
        log.debug(.microtask, "checkpoint.exit", .{
            .frame_id = self.frame_id,
            .processed_count = processed,
        });
    }
}
```

## Implementation Guidelines

### 1. Conditional Compilation

All instrumentation must be debug-only:

```zig
if (comptime @import("builtin").mode == .Debug) {
    // instrumentation code
}
```

### 2. Logging Categories

Add new log categories in `src/support/log.zig`:

```zig
pub const Category = enum {
    // ... existing categories ...
    js_binding,      // JS/native binding layer
    canvas_alloc,    // Canvas allocation
    webidl_convert,  // WebIDL conversions
    microtask,       // Microtask scheduler
};
```

### 3. Error Context

Enhance error returns with context:

```zig
return error.InvalidArgument; // Before

// After:
log.err(.js_binding, "invalid argument", .{
    .api = "getImageData",
    .param = "width",
    .value = width,
    .reason = "negative value",
});
return error.InvalidArgument;
```

### 4. Stack Traces

Capture stack traces on errors:

```zig
const stack = self.stackTrace() catch "no stack";
log.err(.js_binding, "error context", .{
    .stack = stack,
});
```

### 5. Null vs Undefined Distinction

Always distinguish:

```zig
// Return undefined for missing properties
return .{ .local = self, .handle = self.isolate.initUndefined() };

// Return null only when Chrome returns null
return .{ .local = self, .handle = self.isolate.initNull() };
```

## Testing Strategy

1. **Run with debug build:**
   ```bash
   zig build -Doptimize=Debug
   ```

2. **Enable verbose logging:**
   ```bash
   export VELORA_LOG_LEVEL=debug
   ```

3. **Capture instrumentation output:**
   ```bash
   ./zig-out/bin/velora serve --url https://fingerprint-scan.com/ 2>&1 | tee instrumentation.log
   ```

4. **Analyze patterns:**
   ```bash
   grep "returned null" instrumentation.log
   grep "conversion failed" instrumentation.log
   grep "dimension" instrumentation.log
   ```

## Success Criteria

1. **Null returns identified:** Log shows which APIs return null unexpectedly
2. **Overload failures traced:** Log shows exact parameter type mismatches
3. **Allocation issues caught:** Validation prevents fake OOM before allocation
4. **TypedArray invariants held:** Assertions catch semantic violations
5. **Microtask reentry detected:** Log shows exact reentry patterns

## Next Steps

1. Implement Priority 1 (null tracing) first
2. Test against fingerprint-scan.com
3. Analyze logs to identify root causes
4. Fix identified issues
5. Move to Priority 2

## Important Notes

- **Focus on runtime invariants**, not fingerprint-specific hacks
- **Preserve Chrome semantics**, not superficial compatibility
- **Debug-only overhead**, zero cost in release builds
- **Actionable logging**, every log must guide fixes
- **Systematic approach**, fix root causes not symptoms

This instrumentation enables **data-driven debugging** of semantic correctness issues.
