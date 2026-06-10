'use strict';
/* ============================================================
   FABLE UNIVERSE v2 — Barnes-Hut octree (js/core/octree.js)
   Pooled, rebuilt per step. 8 children allocated contiguously;
   nodes store mass-weighted centroid sums during build which
   are normalized afterwards. Force traversal uses an explicit
   stack. Headless: attaches to globalThis only.
   ============================================================ */

(function () {
  const MAX_DEPTH = 24;

  class Octree {
    constructor(nodeCapacity) {
      this.alloc(nodeCapacity || (1 << 16));
      this.root = -1;
      this.builtCount = 0;
    }

    alloc(cap) {
      this.cap = cap;
      this.cx = new Float64Array(cap);     // node center
      this.cy = new Float64Array(cap);
      this.cz = new Float64Array(cap);
      this.size = new Float64Array(cap);   // node edge length
      this.mass = new Float64Array(cap);
      this.comX = new Float64Array(cap);   // mass-weighted sum during build
      this.comY = new Float64Array(cap);
      this.comZ = new Float64Array(cap);
      this.child = new Int32Array(cap);    // index of first of 8 children, -1 = leaf
      this.count = new Int32Array(cap);    // bodies under this node
      this.used = 0;
      this.stack = new Int32Array(8192);
    }

    newNode(x, y, z, s) {
      if (this.used >= this.cap) this.grow();
      const i = this.used++;
      this.cx[i] = x; this.cy[i] = y; this.cz[i] = z;
      this.size[i] = s;
      this.mass[i] = 0;
      this.comX[i] = 0; this.comY[i] = 0; this.comZ[i] = 0;
      this.child[i] = -1;
      this.count[i] = 0;
      return i;
    }

    // Pool grows by doubling. Node indices are stable across a grow, so
    // 8-child blocks allocated while growing stay contiguous.
    grow() {
      const old = this;
      const o = {
        cx: old.cx, cy: old.cy, cz: old.cz, size: old.size, mass: old.mass,
        comX: old.comX, comY: old.comY, comZ: old.comZ,
        child: old.child, count: old.count,
      };
      const used = this.used;
      this.alloc(this.cap * 2);
      this.cx.set(o.cx); this.cy.set(o.cy); this.cz.set(o.cz);
      this.size.set(o.size); this.mass.set(o.mass);
      this.comX.set(o.comX); this.comY.set(o.comY); this.comZ.set(o.comZ);
      this.child.set(o.child); this.count.set(o.count);
      this.used = used;
    }

    // Build from Bodies, inserting only bodies with mass >= massiveMin.
    // Tracers below the threshold never enter the tree.
    build(massiveMin) {
      const B = globalThis.Bodies;
      const min = massiveMin === undefined ? -Infinity : massiveMin;
      const { px, py, pz, mass } = B;
      const n = B.n;

      this.used = 0;
      this.builtCount = 0;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < n; i++) {
        if (mass[i] < min) continue;
        this.builtCount++;
        if (px[i] < minX) minX = px[i];
        if (px[i] > maxX) maxX = px[i];
        if (py[i] < minY) minY = py[i];
        if (py[i] > maxY) maxY = py[i];
        if (pz[i] < minZ) minZ = pz[i];
        if (pz[i] > maxZ) maxZ = pz[i];
      }
      if (this.builtCount === 0) { this.root = -1; return; }

      const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 1.01 + 1;
      this.root = this.newNode(
        (minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2, size);
      for (let i = 0; i < n; i++) {
        if (mass[i] < min) continue;
        this.insert(this.root, px[i], py[i], pz[i], mass[i]);
      }
      // Normalize centroids: comX/Y/Z held mass-weighted sums during insertion.
      for (let k = 0; k < this.used; k++) {
        const m = this.mass[k];
        if (m > 0) { this.comX[k] /= m; this.comY[k] /= m; this.comZ[k] /= m; }
      }
    }

    insert(node, x, y, z, m) {
      let depth = 0;
      for (;;) {
        this.mass[node] += m;
        this.comX[node] += m * x;
        this.comY[node] += m * y;
        this.comZ[node] += m * z;
        this.count[node]++;

        if (this.count[node] === 1) return;                // empty leaf claims body
        if (this.child[node] === -1) {
          // Occupied leaf. At max depth, coincident bodies merge into the
          // node aggregate — softening keeps the force finite anyway.
          if (depth >= MAX_DEPTH) return;
          // Subdivide and push the resident body down one level. Its
          // position is recovered from the centroid sums minus the
          // incoming body.
          const rm = this.mass[node] - m;
          if (rm <= 0) return;                             // degenerate: merge
          const rx = (this.comX[node] - m * x) / rm;
          const ry = (this.comY[node] - m * y) / rm;
          const rz = (this.comZ[node] - m * z) / rm;
          if (this.used + 8 > this.cap) this.grow();
          const base = this.used;
          const h = this.size[node] / 2, q = h / 2;
          const ncx = this.cx[node], ncy = this.cy[node], ncz = this.cz[node];
          for (let k = 0; k < 8; k++) {
            this.newNode(
              ncx + ((k & 1) ? q : -q),
              ncy + ((k & 2) ? q : -q),
              ncz + ((k & 4) ? q : -q),
              h);
          }
          this.child[node] = base;
          const rq = base
            + (rx >= ncx ? 1 : 0) + (ry >= ncy ? 2 : 0) + (rz >= ncz ? 4 : 0);
          this.seed(rq, rx, ry, rz, rm);
        }
        const c = this.child[node];
        node = c
          + (x >= this.cx[node] ? 1 : 0)
          + (y >= this.cy[node] ? 2 : 0)
          + (z >= this.cz[node] ? 4 : 0);
        depth++;
      }
    }

    // Place an already-counted body directly into an empty child octant.
    seed(node, x, y, z, m) {
      this.mass[node] = m;
      this.comX[node] = m * x;
      this.comY[node] = m * y;
      this.comZ[node] = m * z;
      this.count[node] = 1;
    }

    // Acceleration at (x, y, z). A body's own leaf contributes zero force
    // because its centroid coincides with the query point.
    // Opening test: accept node when size^2 < theta2 * dist2.
    accel(x, y, z, theta2, soft2, out) {
      let ax = 0, ay = 0, az = 0;
      if (this.root === -1) { out.x = 0; out.y = 0; out.z = 0; return; }
      const stack = this.stack;
      const massA = this.mass, childA = this.child, sizeA = this.size;
      const comX = this.comX, comY = this.comY, comZ = this.comZ;
      let sp = 0;
      stack[0] = this.root;
      while (sp >= 0) {
        const node = stack[sp--];
        const m = massA[node];
        const dx = comX[node] - x;
        const dy = comY[node] - y;
        const dz = comZ[node] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const s = sizeA[node];
        if (childA[node] === -1 || s * s < theta2 * d2) {
          if (d2 > 1e-12) {
            const ds = d2 + soft2;
            const inv = m / (ds * Math.sqrt(ds));
            ax += dx * inv;
            ay += dy * inv;
            az += dz * inv;
          }
        } else {
          // Open the node: push non-empty children only.
          const c = childA[node];
          if (massA[c] > 0) stack[++sp] = c;
          if (massA[c + 1] > 0) stack[++sp] = c + 1;
          if (massA[c + 2] > 0) stack[++sp] = c + 2;
          if (massA[c + 3] > 0) stack[++sp] = c + 3;
          if (massA[c + 4] > 0) stack[++sp] = c + 4;
          if (massA[c + 5] > 0) stack[++sp] = c + 5;
          if (massA[c + 6] > 0) stack[++sp] = c + 6;
          if (massA[c + 7] > 0) stack[++sp] = c + 7;
        }
      }
      out.x = ax;
      out.y = ay;
      out.z = az;
    }
  }

  globalThis.Octree = Octree;
})();
