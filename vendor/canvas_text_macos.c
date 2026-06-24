// macOS CoreText canvas text rasterization for antidetect profiles.
#include <CoreGraphics/CoreGraphics.h>
#include <CoreText/CoreText.h>
#include <stdbool.h>
#include <stdint.h>

// CGBitmapContext on macOS uses premultiplied ARGB (A,R,G,B per pixel in memory).
// Velora PixelBuffer / PNG encoder use straight RGBA.
static void rgba_to_argb_premul(uint8_t *pixels, uint32_t width, uint32_t height) {
    const uint32_t count = width * height;
    for (uint32_t i = 0; i < count; i++) {
        const uint32_t o = i * 4;
        const uint8_t r = pixels[o];
        const uint8_t g = pixels[o + 1];
        const uint8_t b = pixels[o + 2];
        const uint8_t a = pixels[o + 3];

        pixels[o] = a;
        pixels[o + 1] = (uint8_t)((r * a + 127) / 255);
        pixels[o + 2] = (uint8_t)((g * a + 127) / 255);
        pixels[o + 3] = (uint8_t)((b * a + 127) / 255);
    }
}

static void argb_premul_to_rgba(uint8_t *pixels, uint32_t width, uint32_t height) {
    const uint32_t count = width * height;
    for (uint32_t i = 0; i < count; i++) {
        const uint32_t o = i * 4;
        const uint8_t a = pixels[o];
        const uint8_t r = pixels[o + 1];
        const uint8_t g = pixels[o + 2];
        const uint8_t b = pixels[o + 3];

        if (a == 0) {
            pixels[o] = 0;
            pixels[o + 1] = 0;
            pixels[o + 2] = 0;
            pixels[o + 3] = 0;
            continue;
        }

        pixels[o] = (uint8_t)((r * 255 + a / 2) / a);
        pixels[o + 1] = (uint8_t)((g * 255 + a / 2) / a);
        pixels[o + 2] = (uint8_t)((b * 255 + a / 2) / a);
        pixels[o + 3] = a;
    }
}

bool velora_canvas_fill_text(
    uint8_t *pixels,
    uint32_t width,
    uint32_t height,
    const char *text,
    double x,
    double y,
    double font_size,
    const char *font_family,
    uint8_t r,
    uint8_t g,
    uint8_t b,
    uint8_t a) {
    if (!pixels || width == 0 || height == 0 || !text || text[0] == '\0' || !font_family || font_size <= 0)
        return false;

    CGColorSpaceRef color_space = CGColorSpaceCreateDeviceRGB();
    if (!color_space)
        return false;

    const CGBitmapInfo bitmap_info =
        (CGBitmapInfo)(kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Host);

    rgba_to_argb_premul(pixels, width, height);

    CGContextRef ctx = CGBitmapContextCreate(
        pixels,
        width,
        height,
        8,
        width * 4,
        color_space,
        bitmap_info);
    CGColorSpaceRelease(color_space);
    if (!ctx) {
        argb_premul_to_rgba(pixels, width, height);
        return false;
    }

    CGContextTranslateCTM(ctx, 0, (CGFloat)height);
    CGContextScaleCTM(ctx, 1.0, -1.0);
    CGContextSetShouldAntialias(ctx, true);
    CGContextSetAllowsFontSubpixelPositioning(ctx, true);
    CGContextSetAllowsFontSubpixelQuantization(ctx, true);

    CFStringRef family = CFStringCreateWithCString(NULL, font_family, kCFStringEncodingUTF8);
    if (!family) {
        CGContextRelease(ctx);
        return false;
    }

    CTFontRef font = CTFontCreateWithName(family, font_size, NULL);
    CFRelease(family);
    if (!font) {
        CGContextRelease(ctx);
        return false;
    }

    CFStringRef string = CFStringCreateWithCString(NULL, text, kCFStringEncodingUTF8);
    if (!string) {
        CFRelease(font);
        CGContextRelease(ctx);
        return false;
    }

    CGColorSpaceRef rgb = CGColorSpaceCreateDeviceRGB();
    if (!rgb) {
        CFRelease(string);
        CFRelease(font);
        CGContextRelease(ctx);
        return false;
    }
    CGFloat components[4] = {
        (CGFloat)r / 255.0,
        (CGFloat)g / 255.0,
        (CGFloat)b / 255.0,
        (CGFloat)a / 255.0,
    };
    CGColorRef color = CGColorCreate(rgb, components);
    CGColorSpaceRelease(rgb);

    const CFStringRef keys[] = {kCTFontAttributeName, kCTForegroundColorAttributeName};
    const CFTypeRef values[] = {font, color};
    CFDictionaryRef attrs = CFDictionaryCreate(
        NULL,
        (const void **)keys,
        (const void **)values,
        2,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);

    CFAttributedStringRef attr_string = CFAttributedStringCreate(NULL, string, attrs);
    CFRelease(attrs);
    CFRelease(string);
    CGColorRelease(color);
    CFRelease(font);
    if (!attr_string) {
        CGContextRelease(ctx);
        return false;
    }

    CTLineRef line = CTLineCreateWithAttributedString(attr_string);
    CFRelease(attr_string);
    if (!line) {
        CGContextRelease(ctx);
        return false;
    }

    // HTML canvas fillText: (x, y) is the alphabetic baseline.
    CGContextSetTextPosition(ctx, (CGFloat)x, (CGFloat)y);
    CTLineDraw(line, ctx);
    CFRelease(line);
    CGContextRelease(ctx);

    argb_premul_to_rgba(pixels, width, height);
    return true;
}