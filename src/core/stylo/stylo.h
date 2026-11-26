#ifndef KOKO_STYLO_H
#define KOKO_STYLO_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct StyloEngine StyloEngine;

typedef enum StyloStatus {
    STYLO_STATUS_OK = 0,
    STYLO_STATUS_INVALID_ARGUMENT = 1,
    STYLO_STATUS_NULL_POINTER = 2,
    STYLO_STATUS_INVALID_UTF8 = 3,
    STYLO_STATUS_CALLBACK_MISSING = 4,
    STYLO_STATUS_CALLBACK_FAILED = 5,
    STYLO_STATUS_UNSUPPORTED = 6,
    STYLO_STATUS_PANIC = 7,
    STYLO_STATUS_BUFFER_TOO_SMALL = 8,
    STYLO_STATUS_PARSE_ERROR = 9,
} StyloStatus;

typedef struct StyloSlice {
    const uint8_t *ptr;
    size_t len;
} StyloSlice;

typedef struct StyloNodeInfo {
    uint64_t node_id;
    uint64_t parent_id;
    uint64_t first_child_id;
    uint64_t last_child_id;
    uint64_t prev_sibling_id;
    uint64_t next_sibling_id;
    uint64_t shadow_host_id;
    uint64_t shadow_root_id;
    uint32_t kind;
    uint64_t flags;
    uint32_t text_len;
    StyloSlice tag_name;
    StyloSlice namespace_name;
    StyloSlice id;
    StyloSlice classes;
    StyloSlice style;
    StyloSlice attribute_names;
} StyloNodeInfo;

typedef StyloStatus (*StyloReadNodeCallback)(
    void *ctx,
    const void *node,
    StyloNodeInfo *out);

typedef StyloStatus (*StyloReadAttrCallback)(
    void *ctx,
    const void *node,
    StyloSlice name,
    StyloSlice namespace_name,
    StyloSlice *out);

typedef struct StyloDomCallbacks {
    void *ctx;
    StyloReadNodeCallback read_node;
    StyloReadAttrCallback read_attr;
} StyloDomCallbacks;

typedef enum StyloStylesheetOrigin {
    STYLO_STYLESHEET_USER_AGENT = 0,
    STYLO_STYLESHEET_USER = 1,
    STYLO_STYLESHEET_AUTHOR = 2,
} StyloStylesheetOrigin;

typedef struct StyloStylesheetInput {
    uint64_t sheet_id;
    uint64_t scope_id;
    StyloStylesheetOrigin origin;
    uint8_t enabled;
    uint8_t reserved[7];
    StyloSlice css;
} StyloStylesheetInput;

typedef struct StyloFlushResult {
    uint64_t invalidation_generation;
    size_t changed_node_count;
} StyloFlushResult;

typedef struct StyloMetrics {
    uint64_t stylesheet_rebuilds;
    uint64_t stylesheet_parses;
    uint64_t stylesheet_bytes;
    uint64_t dom_invalidations;
    uint64_t restyled_nodes;
    uint64_t computed_cache_hits;
    uint64_t computed_cache_misses;
    uint64_t ffi_calls;
    uint64_t copied_bytes;
} StyloMetrics;

uint32_t koko_stylo_abi_version(void);

StyloStatus koko_stylo_engine_new(
    const StyloDomCallbacks *callbacks,
    StyloEngine **out_engine);

StyloStatus koko_stylo_engine_destroy(StyloEngine *engine);

StyloStatus koko_stylo_engine_replace_stylesheets(
    StyloEngine *engine,
    const StyloStylesheetInput *inputs,
    size_t count);

StyloStatus koko_stylo_engine_invalidate_stylesheets(StyloEngine *engine);

StyloStatus koko_stylo_engine_sync_node(
    StyloEngine *engine,
    const void *node);

StyloStatus koko_stylo_engine_invalidate_dom(
    StyloEngine *engine,
    const void *node,
    uint32_t kind);

StyloStatus koko_stylo_engine_reset_document(
    StyloEngine *engine);

StyloStatus koko_stylo_engine_sync_node_info(
    StyloEngine *engine,
    const void *node,
    StyloNodeInfo *out);

StyloStatus koko_stylo_engine_invalidation_generation(
    const StyloEngine *engine,
    uint64_t *out_generation);

StyloStatus koko_stylo_engine_metrics(
    const StyloEngine *engine,
    StyloMetrics *out_metrics);

StyloStatus koko_stylo_engine_flush_styles(
    StyloEngine *engine,
    const uint64_t *nodes,
    size_t node_count,
    StyloFlushResult *out_result);

StyloStatus koko_stylo_engine_serialize_property(
    StyloEngine *engine,
    uint64_t node_id,
    StyloSlice property,
    uint8_t *out,
    size_t capacity,
    size_t *written);

StyloStatus koko_stylo_engine_query_visibility(
    StyloEngine *engine,
    uint64_t node_id,
    uint64_t generation,
    uint8_t *out_value);

StyloStatus koko_stylo_engine_query_pointer_events(
    StyloEngine *engine,
    uint64_t node_id,
    uint64_t generation,
    uint8_t *out_value);

StyloStatus koko_stylo_engine_serialize_pseudo_property(
    StyloEngine *engine,
    uint64_t node_id,
    StyloSlice pseudo,
    StyloSlice property,
    uint8_t *out,
    size_t capacity,
    size_t *written);

StyloStatus koko_stylo_engine_serialize_specified_property(
    StyloEngine *engine,
    StyloSlice property,
    StyloSlice value,
    uint8_t *out,
    size_t capacity,
    size_t *written);

StyloStatus koko_stylo_engine_stylesheet_count(
    const StyloEngine *engine,
    size_t *out_count);

StyloStatus koko_stylo_engine_stylesheet_rule_count(
    const StyloEngine *engine,
    uint64_t sheet_id,
    size_t *out_count);

StyloStatus koko_stylo_engine_last_error(
    const StyloEngine *engine,
    uint8_t *out,
    size_t capacity,
    size_t *written);

#ifdef __cplusplus
}
#endif

#endif /* KOKO_STYLO_H */
