'use strict';
/* ============================================================
   FABLE UNIVERSE v5 — WebGPU post effects (globalThis.PostWGPU).

   WGSL port of js/render/postfx.js, same constants, same chain:

     scene (rgba16float, from RendererWGPU)
       → bright-pass downsample (half res, smoothstep(0.35, 0.9) knee)
       → separable gaussian blur ×2 (5-tap, 0.227/0.3162/0.0702,
         offsets 1.3846/3.2308)
       → final: per-pixel point-lens warp β = θ·(1 − θE²/|θ|²)
         around ≤8 black holes (Einstein K = 0.36, θE clamped to
         18% viewport height), photon ring at 1.08·θE, shadow
         smoothstep, bloom add ×1.35, ACES → canvas.

   The BH screen projection helper is ported from PostFX.apply
   verbatim except sy is flipped (WebGPU framebuffer coords are
   y-down where GL's are y-up); all passes derive uv from
   @builtin(position)/res so scene/bloom/canvas orientations agree.

   apply(encoder, sceneView, opts) ENCODES into the caller's
   command encoder (RendererWGPU submits once per frame). There is
   no fallback present: if PostWGPU.init fails, RendererWGPU.init
   returns null and the app falls back to WebGL entirely.
   ============================================================ */
(function () {
  const MAX_BH = 8;
  const K = 0.36;                  // Einstein radius tuning, as PostFX
  const POST_FORMAT = 'rgba16float';

  const FULLSCREEN_VS = `
@vertex fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

  const BRIGHT_WGSL = FULLSCREEN_VS + `
@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var samp : sampler;
struct Params { res : vec2f, pad : vec2f };   // res = half-res target size
@group(0) @binding(2) var<uniform> P : Params;
@fragment fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let uv = pos.xy / P.res;
  let c = textureSample(srcTex, samp, uv).rgb;
  let l = dot(c, vec3f(0.299, 0.587, 0.114));
  // soft knee around 0.5: cores bloom, faint stars stay crisp
  return vec4f(c * smoothstep(0.35, 0.9, l), 1.0);
}
`;

  const BLUR_WGSL = FULLSCREEN_VS + `
@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var samp : sampler;
struct Params { dir : vec2f, res : vec2f };   // dir = (1/w, 0) or (0, 1/h)
@group(0) @binding(2) var<uniform> P : Params;
@fragment fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let uv = pos.xy / P.res;
  var c = textureSample(srcTex, samp, uv).rgb * 0.227;
  let o1 = P.dir * 1.3846;
  let o2 = P.dir * 3.2308;
  c += (textureSample(srcTex, samp, uv + o1).rgb +
        textureSample(srcTex, samp, uv - o1).rgb) * 0.3162;
  c += (textureSample(srcTex, samp, uv + o2).rgb +
        textureSample(srcTex, samp, uv - o2).rgb) * 0.0702;
  return vec4f(c, 1.0);
}
`;

  const FINAL_WGSL = FULLSCREEN_VS + `
@group(0) @binding(0) var sceneTex : texture_2d<f32>;
@group(0) @binding(1) var bloomTex : texture_2d<f32>;
@group(0) @binding(2) var samp : sampler;
struct LensU {
  res : vec2f,                     // backing-store pixels
  nbh : f32,
  pad : f32,
  bh : array<vec4f, ${MAX_BH}>,    // sx, sy (px, y-down), thetaE_px, shadow_px
};
@group(0) @binding(3) var<uniform> L : LensU;

fn aces(x : vec3f) -> vec3f {
  return clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14),
               vec3f(0.0), vec3f(1.0));
}

@fragment fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let px = pos.xy;
  var samplePx = px;
  var ring = 0.0;
  var shadow = 1.0;
  let n = u32(L.nbh + 0.5);
  for (var i = 0u; i < ${MAX_BH}u; i++) {
    if (i >= n) { break; }
    let c = L.bh[i].xy;
    let thetaE = L.bh[i].z;
    let d = px - c;
    let r = length(d);
    if (r > thetaE * 8.0) { continue; }
    let r2 = max(r * r, 1e-4);
    let warp = 1.0 - (thetaE * thetaE) / r2;
    samplePx = c + (samplePx - c) * warp;
    let t = abs(r - thetaE * 1.08) / (thetaE * 0.16 + 1.0);
    ring += exp(-t * t * 3.0) * 0.55;
    shadow *= smoothstep(L.bh[i].w * 0.55, L.bh[i].w, r);
  }
  let uv = clamp(samplePx / L.res, vec2f(0.001), vec2f(0.999));
  var c = textureSample(sceneTex, samp, uv).rgb +
          textureSample(bloomTex, samp, uv).rgb * 1.35;
  c += ring * vec3f(0.75, 0.85, 1.0) * (c + vec3f(0.06));
  c *= shadow;
  return vec4f(aces(c), 1.0);
}
`;

  // ---------------------------------------------------------------- state
  let device = null, context = null, format = null;
  let pipeBright = null, pipeBlur = null, pipeFinal = null;
  let sampler = null;
  let texA = null, texB = null, viewA = null, viewB = null;
  let brightU = null, blurHU = null, blurVU = null, lensU = null;
  let halfW = 0, halfH = 0;
  let W = 1, H = 1, DPR = 1;
  const lensData = new Float32Array(4 + MAX_BH * 4); // res, nbh, pad | bh[8]

  function fullscreenPipeline(code, targetFormat) {
    const mod = device.createShaderModule({ code });
    return device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs',
                  targets: [{ format: targetFormat }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  function uniformBuf(bytes) {
    return device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  function allocBloomTargets() {
    if (texA) texA.destroy();
    if (texB) texB.destroy();
    halfW = Math.max(1, Math.round(W * DPR / 2));
    halfH = Math.max(1, Math.round(H * DPR / 2));
    const make = () => device.createTexture({
      size: [halfW, halfH],
      format: POST_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    texA = make(); viewA = texA.createView();
    texB = make(); viewB = texB.createView();
    device.queue.writeBuffer(brightU, 0, new Float32Array([halfW, halfH, 0, 0]));
    device.queue.writeBuffer(blurHU, 0, new Float32Array([1 / halfW, 0, halfW, halfH]));
    device.queue.writeBuffer(blurVU, 0, new Float32Array([0, 1 / halfH, halfW, halfH]));
  }

  function pass(encoder, pipeline, view, entries) {
    const rp = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp: 'store',
      }],
    });
    rp.setPipeline(pipeline);
    rp.setBindGroup(0, device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries,
    }));
    rp.draw(3);
    rp.end();
  }

  const PostWGPU = {
    init(wgpu) {
      if (!wgpu || !wgpu.device || !wgpu.context || !wgpu.format) return false;
      device = wgpu.device;
      context = wgpu.context;
      format = wgpu.format;
      try {
        pipeBright = fullscreenPipeline(BRIGHT_WGSL, POST_FORMAT);
        pipeBlur = fullscreenPipeline(BLUR_WGSL, POST_FORMAT);
        pipeFinal = fullscreenPipeline(FINAL_WGSL, format);
        sampler = device.createSampler({
          magFilter: 'linear', minFilter: 'linear',
          addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
        });
        brightU = uniformBuf(16);
        blurHU = uniformBuf(16);
        blurVU = uniformBuf(16);
        lensU = uniformBuf(lensData.byteLength);
        allocBloomTargets();
        return true;
      } catch (e) {
        console.warn('PostWGPU init failed:', e && e.message);
        pipeFinal = null;
        return false;
      }
    },

    resize(w, h, dpr) {
      W = Math.max(1, w); H = Math.max(1, h); DPR = dpr || 1;
      if (pipeFinal) allocBloomTargets();
    },

    /* apply(encoder, sceneView, { blackHoles, viewProj, viewportH,
       dpr }) — encode bright/blur/composite into the caller's
       encoder, presenting onto the current canvas texture. The BH
       screen-projection prologue is the PostFX.apply math with sy
       flipped for WebGPU's y-down framebuffer coordinates. */
    apply(encoder, sceneView, opts) {
      if (!pipeFinal) return false;
      const vp = opts.viewProj;
      const bhs = opts.blackHoles || [];
      const Wpx = W * DPR, Hpx = H * DPR;
      let n = 0;
      if (vp) {
        for (let i = 0; i < bhs.length && n < MAX_BH; i++) {
          const b = bhs[i];
          const cx = vp[0] * b.x + vp[4] * b.y + vp[8] * b.z + vp[12];
          const cy = vp[1] * b.x + vp[5] * b.y + vp[9] * b.z + vp[13];
          const cw = vp[3] * b.x + vp[7] * b.y + vp[11] * b.z + vp[15];
          if (cw < 0.1) continue;
          const sx = (cx / cw * 0.5 + 0.5) * Wpx;
          const sy = (0.5 - cy / cw * 0.5) * Hpx;   // y-down framebuffer
          // Einstein radius θE ∝ sqrt(M)/depth; K tuned so a 40000-mass
          // hole at depth 1500 reads at ~5% of viewport height.
          let thetaE = K * Math.sqrt(b.mass) / cw * Hpx;
          thetaE = Math.min(thetaE, 0.18 * Hpx);
          if (thetaE < 2 * DPR) continue;
          const margin = thetaE * 8;
          if (sx < -margin || sx > Wpx + margin ||
              sy < -margin || sy > Hpx + margin) continue;
          const shadowPx = Math.max(thetaE * 0.45, (b.rad * 2 / cw) * Hpx);
          lensData[4 + n * 4] = sx;
          lensData[4 + n * 4 + 1] = sy;
          lensData[4 + n * 4 + 2] = thetaE;
          lensData[4 + n * 4 + 3] = shadowPx;
          n++;
        }
      }
      lensData[0] = Wpx; lensData[1] = Hpx;
      lensData[2] = n; lensData[3] = 0;
      device.queue.writeBuffer(lensU, 0, lensData);

      // bright pass: scene -> A (half res)
      pass(encoder, pipeBright, viewA, [
        { binding: 0, resource: sceneView },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: brightU } },
      ]);
      // blur: A -> B (horizontal), B -> A (vertical)
      pass(encoder, pipeBlur, viewB, [
        { binding: 0, resource: viewA },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: blurHU } },
      ]);
      pass(encoder, pipeBlur, viewA, [
        { binding: 0, resource: viewB },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: blurVU } },
      ]);
      // final: lens + bloom composite + tone map -> canvas
      pass(encoder, pipeFinal, context.getCurrentTexture().createView(), [
        { binding: 0, resource: sceneView },
        { binding: 1, resource: viewA },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: lensU } },
      ]);
      return true;
    },
  };

  globalThis.PostWGPU = PostWGPU;
})();
