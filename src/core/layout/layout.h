#ifndef KOKO_LAYOUT_H
#define KOKO_LAYOUT_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct KokoLayoutSession KokoLayoutSession;
typedef uint64_t KokoLayoutNode;

typedef enum KokoLayoutStatus {
    KOKO_LAYOUT_OK = 0,
    KOKO_LAYOUT_INVALID_ARGUMENT = 1,
    KOKO_LAYOUT_INVALID_HANDLE = 2,
    KOKO_LAYOUT_NOT_READY = 3,
    KOKO_LAYOUT_INTERNAL_ERROR = 4,
    KOKO_LAYOUT_PANIC = 5,
    KOKO_LAYOUT_UNSUPPORTED = 6,
} KokoLayoutStatus;

/* Geometry is written only after a successful compute call. */
typedef struct KokoLayoutGeometry {
    float x;
    float y;
    float width;
    float height;
    float border_left;
    float border_right;
    float border_top;
    float border_bottom;
    float padding_left;
    float padding_right;
    float padding_top;
    float padding_bottom;
    float margin_left;
    float margin_right;
    float margin_top;
    float margin_bottom;
} KokoLayoutGeometry;

typedef struct KokoLayoutProperty {
    const uint8_t *name;
    uintptr_t name_len;
    const uint8_t *value;
    uintptr_t value_len;
} KokoLayoutProperty;

KokoLayoutSession *koko_layout_session_new(void);
void koko_layout_session_free(KokoLayoutSession *session);

KokoLayoutStatus koko_layout_session_begin_batch(KokoLayoutSession *session);
KokoLayoutStatus koko_layout_session_end_batch(KokoLayoutSession *session);
KokoLayoutStatus koko_layout_session_reset(KokoLayoutSession *session);

KokoLayoutNode koko_layout_node_new(KokoLayoutSession *session);
KokoLayoutStatus koko_layout_node_free(KokoLayoutSession *session, KokoLayoutNode node);
KokoLayoutStatus koko_layout_node_set_computed_style(
    KokoLayoutSession *session,
    KokoLayoutNode node,
    const KokoLayoutProperty *properties,
    uint64_t property_count,
    float viewport_width,
    float viewport_height
);

/*
 * Applies only text shaping/line-breaking properties to a node. This narrow
 * API does not require box properties such as display, width, or height.
 * Supported property names: font-family, font-size, font-weight, font-style,
 * line-height, direction, and white-space.
 */
KokoLayoutStatus koko_layout_node_set_text_style(
    KokoLayoutSession *session,
    KokoLayoutNode node,
    const KokoLayoutProperty *properties,
    uint64_t property_count
);
KokoLayoutStatus koko_layout_node_set_text(
    KokoLayoutSession *session,
    KokoLayoutNode node,
    const uint8_t *text,
    uint64_t text_len
);
KokoLayoutStatus koko_layout_append_child(
    KokoLayoutSession *session,
    KokoLayoutNode parent,
    KokoLayoutNode child
);

/* Computes real Taffy geometry for root using the supplied definite viewport. */
KokoLayoutStatus koko_layout_compute(
    KokoLayoutSession *session,
    KokoLayoutNode root,
    float viewport_width,
    float viewport_height
);

/*
 * Fills a caller-owned array in one operation. No values are written when the
 * session has not been computed or a handle is invalid. `out_count` is always
 * set to zero before validation and to `count` only on success.
 */
KokoLayoutStatus koko_layout_snapshot_batch(
    const KokoLayoutSession *session,
    const KokoLayoutNode *nodes,
    uint64_t count,
    KokoLayoutGeometry *out,
    uint64_t out_capacity,
    uint64_t *out_count
);

/*
 * Same as koko_layout_snapshot_batch, but accumulates each node's Taffy
 * parent locations up to the tree root. Coordinates are root/document-tree
 * coordinates; scrolling, transforms, and iframe offsets remain Zig-side.
 */
KokoLayoutStatus koko_layout_snapshot_absolute_batch(
    const KokoLayoutSession *session,
    const KokoLayoutNode *nodes,
    uint64_t count,
    KokoLayoutGeometry *out,
    uint64_t out_capacity,
    uint64_t *out_count
);

#ifdef __cplusplus
}
#endif

#endif
