// Temporary Linux prebuilt shims for C bindings present in vendor/v8-wrapper
// Enough for linking; behavior is approximate for smoke tests only.

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct Isolate Isolate;
typedef struct String String;
typedef struct Context Context;

typedef enum {
  kNormal = 0,
  kInternalized = 1,
} NewStringType;

extern String *v8__String__NewFromUtf8(Isolate *isolate, const char *data,
                                       NewStringType type, int length);
extern int v8__String__Utf8Length(const String *self, Isolate *isolate);
extern int v8__String__WriteUtf8(const String *self, Isolate *isolate,
                                 char *buffer, int length, int options);
extern int v8__String__Length(const String *self);
extern Context *v8__Isolate__GetCurrentContext(Isolate *isolate);

// UTF-16 → UTF-8 (BMP + surrogate pairs; lone surrogates as U+FFFD).
static char *utf16_to_utf8(const uint16_t *data, int length, int *out_len) {
  if (length <= 0) {
    char *empty = (char *)malloc(1);
    if (empty)
      empty[0] = 0;
    *out_len = 0;
    return empty;
  }
  // worst case 3 bytes per code unit (or 4 for supplementary via surrogates)
  size_t cap = (size_t)length * 3 + 4;
  char *buf = (char *)malloc(cap);
  if (!buf) {
    *out_len = 0;
    return NULL;
  }
  size_t o = 0;
  for (int i = 0; i < length; i++) {
    uint32_t cp = data[i];
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < length) {
      uint16_t low = data[i + 1];
      if (low >= 0xDC00 && low <= 0xDFFF) {
        cp = 0x10000 + (((cp - 0xD800) << 10) | (low - 0xDC00));
        i++;
      } else {
        cp = 0xFFFD;
      }
    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
      cp = 0xFFFD;
    }
    if (cp < 0x80) {
      buf[o++] = (char)cp;
    } else if (cp < 0x800) {
      buf[o++] = (char)(0xC0 | (cp >> 6));
      buf[o++] = (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      buf[o++] = (char)(0xE0 | (cp >> 12));
      buf[o++] = (char)(0x80 | ((cp >> 6) & 0x3F));
      buf[o++] = (char)(0x80 | (cp & 0x3F));
    } else {
      buf[o++] = (char)(0xF0 | (cp >> 18));
      buf[o++] = (char)(0x80 | ((cp >> 12) & 0x3F));
      buf[o++] = (char)(0x80 | ((cp >> 6) & 0x3F));
      buf[o++] = (char)(0x80 | (cp & 0x3F));
    }
  }
  *out_len = (int)o;
  return buf;
}

String *v8__String__NewFromTwoByte(Isolate *isolate, const uint16_t *data,
                                   NewStringType type, int length) {
  int n = 0;
  char *utf8 = utf16_to_utf8(data, length, &n);
  if (!utf8)
    return NULL;
  String *s = v8__String__NewFromUtf8(isolate, utf8, type, n);
  free(utf8);
  return s;
}

// Decode UTF-8 from WriteUtf8 into UTF-16 code units (lossy for invalid
// sequences).
void v8__String__WriteUtf16(const String *self, Isolate *isolate,
                            uint32_t offset, uint32_t length,
                            uint16_t *buffer) {
  (void)offset;
  int utf8_len = v8__String__Utf8Length(self, isolate);
  if (utf8_len <= 0 || length == 0)
    return;
  char *tmp = (char *)malloc((size_t)utf8_len + 1);
  if (!tmp)
    return;
  // options: NO_NULL_TERMINATION = 1 typically; pass 0 for simplicity
  int n = v8__String__WriteUtf8(self, isolate, tmp, utf8_len, 0);
  if (n < 0)
    n = 0;
  uint32_t out = 0;
  int i = 0;
  while (i < n && out < length) {
    unsigned char c = (unsigned char)tmp[i];
    uint32_t cp;
    if (c < 0x80) {
      cp = c;
      i += 1;
    } else if ((c & 0xE0) == 0xC0 && i + 1 < n) {
      cp = ((c & 0x1F) << 6) | ((unsigned char)tmp[i + 1] & 0x3F);
      i += 2;
    } else if ((c & 0xF0) == 0xE0 && i + 2 < n) {
      cp = ((c & 0x0F) << 12) | (((unsigned char)tmp[i + 1] & 0x3F) << 6) |
           ((unsigned char)tmp[i + 2] & 0x3F);
      i += 3;
    } else if ((c & 0xF8) == 0xF0 && i + 3 < n) {
      cp = ((c & 0x07) << 18) | (((unsigned char)tmp[i + 1] & 0x3F) << 12) |
           (((unsigned char)tmp[i + 2] & 0x3F) << 6) |
           ((unsigned char)tmp[i + 3] & 0x3F);
      i += 4;
    } else {
      cp = 0xFFFD;
      i += 1;
    }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      if (out + 1 >= length)
        break;
      buffer[out++] = (uint16_t)(0xD800 + (cp >> 10));
      buffer[out++] = (uint16_t)(0xDC00 + (cp & 0x3FF));
    } else {
      buffer[out++] = (uint16_t)cp;
    }
  }
  free(tmp);
}

// Approximate: prebuilt lacks this C wrapper; current context is close enough
// for serve smoke tests.
Context *v8__Isolate__GetEnteredOrMicrotaskContext(Isolate *isolate) {
  return v8__Isolate__GetCurrentContext(isolate);
}
