'use strict';
// TreePack: flattened escape-pointer tree must reproduce octree.accel.
// Run: node test/treepack.test.js

const fs = require('fs');
const path = require('path');
for (const f of ['js/core/bodies.js', 'js/core/octree.js', 'js/core/treepack.js']) {
  (0, eval)(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
}
const { Bodies, Octree, TreePack } = globalThis;

let failed = false;
const check = (cond, msg, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg + (extra ? `  [${extra}]` : ''));
  if (!cond) failed = true;
};

// Deterministic RNG.
let s = 12345;
const rng = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

Bodies.clear();
for (let i = 0; i < 500; i++) {
  const r = Math.cbrt(rng()) * 800;
  const ct = 2 * rng() - 1, st = Math.sqrt(1 - ct * ct), ph = 2 * Math.PI * rng();
  Bodies.add(r * st * Math.cos(ph), r * st * Math.sin(ph), r * ct,
             0, 0, 0, 0.5 + rng() * 3, 1, 0, Bodies.TYPE_STAR, null);
}

const tree = new Octree(1 << 14);
tree.build(0.01);
const { data, nodeCount } = TreePack.flatten(tree);

// --- structural sanity: hit/miss walk visits every node exactly once.
{
  const seen = new Uint8Array(nodeCount);
  let i = 0, visits = 0;          // root is node 0 (preorder)
  while (i >= 0 && visits <= nodeCount + 1) {
    if (seen[i]) { failed = true; break; }
    seen[i] = 1;
    visits++;
    const hit = data[i * 8 + 5];
    i = hit >= 0 ? hit : data[i * 8 + 6];
  }
  let all = visits === nodeCount;
  for (let k = 0; k < nodeCount; k++) if (!seen[k]) all = false;
  check(all, `walk visits every node exactly once`, `${visits}/${nodeCount} nodes`);
}

// --- reference flat traversal (the exact shader loop).
function flatAccel(x, y, z, theta2, soft2) {
  let ax = 0, ay = 0, az = 0;
  let i = 0, guard = 0;
  while (i >= 0 && guard++ < 100000) {
    const o = i * 8;
    const hit = data[o + 5];
    const dx = data[o] - x, dy = data[o + 1] - y, dz = data[o + 2] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (hit >= 0 && data[o + 4] >= theta2 * d2) {
      i = hit;                                    // open
    } else {
      if (d2 > 1e-12) {
        const inv = data[o + 3] / ((d2 + soft2) * Math.sqrt(d2 + soft2));
        ax += dx * inv; ay += dy * inv; az += dz * inv;
      }
      i = data[o + 6];                            // escape
    }
  }
  return [ax, ay, az];
}

const out = { x: 0, y: 0, z: 0 };
for (const theta2 of [0, 1.21]) {
  let maxRel = 0;
  for (let p = 0; p < 50; p++) {
    const x = (rng() * 2 - 1) * 900, y = (rng() * 2 - 1) * 900, z = (rng() * 2 - 1) * 900;
    tree.accel(x, y, z, theta2, 36, out);
    const [ax, ay, az] = flatAccel(x, y, z, theta2, 36);
    const mag = Math.hypot(out.x, out.y, out.z) || 1e-30;
    const err = Math.hypot(ax - out.x, ay - out.y, az - out.z) / mag;
    if (err > maxRel) maxRel = err;
  }
  check(maxRel < 1e-6, `flat traversal matches octree.accel at theta2=${theta2}`,
        `max rel err ${maxRel.toExponential(2)}`);
}

// --- preallocated buffer reuse path
{
  const buf = new Float32Array(tree.used * 8);
  const r2 = TreePack.flatten(tree, buf);
  check(r2.data === buf && r2.nodeCount === nodeCount, 'flatten reuses caller buffer');
}

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
