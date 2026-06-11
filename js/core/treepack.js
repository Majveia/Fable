'use strict';
/* ============================================================
   FABLE UNIVERSE v3 — octree texture flattening (js/core/treepack.js)
   Escape-pointer linearization of the Barnes-Hut octree for
   stackless GPU traversal. Two RGBA32F texels per node:
     T0 = (comX, comY, comZ, mass)
     T1 = (size^2, hitIndex, missIndex, leafBodySlot or -1)
   Indices are NODE indices (texel offset = nodeIndex * 2).
   Layout is preorder: hit = first non-empty child (descend),
   miss = next sibling, or the nearest ancestor's next sibling
   (escape). The miss pointer of the last child chains to the
   parent's miss; the root's miss is -1. Zero-mass children are
   skipped, mirroring the CPU traversal. Leaves have hit = -1.

   Traversal contract (shader + reference tests):
     i = root;
     while (i >= 0) {
       if (hit >= 0 && size2 >= theta2 * dist2) i = hit;   // open
       else { accumulate; i = miss; }                       // escape
     }

   Note: the octree stores no body ids, so leafBodySlot is always
   -1; the integration shader needs no self-exclusion because a
   coincident centroid yields a zero direction vector (and the
   d2 guard handles unsoftened configurations).

   Pure + DOM-free: attaches to globalThis only, Node-testable.
   ============================================================ */
(function () {
  const FLOATS_PER_NODE = 8; // 2 RGBA texels

  // Module-level emit state avoids per-call closures; recursion
  // depth is bounded by the octree's MAX_DEPTH (24) + 1.
  let _data = null;
  let _next = 0;
  let _oct = null;

  // Preorder emission. In a preorder layout the escape structure is
  // positional: hit = ownIndex + 1 (the first child follows
  // immediately), miss = ownIndex + subtreeSize (the first node that
  // is not in this subtree). Returns the subtree size in nodes.
  // Out-of-range miss pointers are normalized to -1 by flatten().
  function emit(node) {
    const oct = _oct, data = _data;
    const idx = _next++;
    const o = idx * FLOATS_PER_NODE;
    data[o] = oct.comX[node];
    data[o + 1] = oct.comY[node];
    data[o + 2] = oct.comZ[node];
    data[o + 3] = oct.mass[node];
    const s = oct.size[node];
    data[o + 4] = s * s;
    data[o + 5] = -1;        // hit: set below if a non-empty child exists
    data[o + 7] = -1;        // leaf body slot (octree stores no ids)
    let size = 1;
    const c = oct.child[node];
    if (c !== -1) {
      let first = true;
      for (let k = 0; k < 8; k++) {
        const ch = c + k;
        if (oct.mass[ch] <= 0) continue;          // skip empty children
        if (first) { data[o + 5] = _next; first = false; }
        size += emit(ch);
      }
    }
    data[o + 6] = idx + size;                     // miss = first node after subtree
    return size;
  }

  const TreePack = {
    FLOATS_PER_NODE,

    /* flatten(octree[, out]) -> { data: Float32Array, nodeCount }
       out: optional preallocated Float32Array (avoids per-frame
       garbage); a fresh array of octree.used * 8 floats (an upper
       bound on the flattened size) is allocated when out is
       missing or too small. Only nodeCount * 8 floats are valid. */
    flatten(octree, out) {
      if (!octree || octree.root === -1 || octree.used === 0) {
        return { data: out || new Float32Array(0), nodeCount: 0 };
      }
      const need = octree.used * FLOATS_PER_NODE;
      _data = (out && out.length >= need) ? out : new Float32Array(need);
      _next = 0;
      _oct = octree;
      emit(octree.root);
      // Normalize escape pointers that run off the end of the layout.
      for (let i = 0; i < _next; i++) {
        if (_data[i * FLOATS_PER_NODE + 6] >= _next) _data[i * FLOATS_PER_NODE + 6] = -1;
      }
      const res = { data: _data, nodeCount: _next };
      _data = null;
      _oct = null;
      return res;
    },
  };

  globalThis.TreePack = TreePack;
})();
