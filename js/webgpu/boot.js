'use strict';
/* ============================================================
   FABLE UNIVERSE v5 — WebGPU bootstrap (js/webgpu/boot.js)

   WGPU.boot(canvas) -> the WGPU object ({ device, context,
   format, maxBodiesCap }) on success, null on ANY failure (no
   throws escape — main.js falls back to WebGL2 / CPU engines).

   Default device limits are requested (nothing exotic): pos/vel/
   attrib buffers are 32 MB each at the 2M-body target, well under
   the 128 MB default maxStorageBufferBindingSize. The limits are
   still verified at boot; if a device caps below the target the
   actual body cap is exposed as WGPU.maxBodiesCap and consumers
   (PhysicsWGPU.init) clamp to it.
   ============================================================ */
(function () {
  const TARGET_MAX_BODIES = 1 << 21;   // 2,097,152 (v5 contract)
  const BYTES_PER_SLOT = 16;           // one vec4f per body per buffer

  const WGPU = {
    adapter: null,
    device: null,
    context: null,
    format: null,
    maxBodiesCap: 0,

    async boot(canvas) {
      try {
        if (!canvas || !navigator.gpu) return null;
        const adapter = await navigator.gpu.requestAdapter(
          { powerPreference: 'high-performance' });
        if (!adapter) return null;
        const device = await adapter.requestDevice();
        if (!device) return null;

        const onError = (e) => {
          const err = e && e.error ? e.error.message : e;
          console.warn('WGPU uncaptured error:', err);
        };
        if (typeof device.addEventListener === 'function') {
          device.addEventListener('uncapturederror', onError);
        } else {
          device.onuncapturederror = onError;
        }

        // Verify the per-slot buffers fit; cap the body count if not.
        const lim = device.limits;
        const cap = Math.min(
          TARGET_MAX_BODIES,
          Math.floor(lim.maxStorageBufferBindingSize / BYTES_PER_SLOT),
          Math.floor(lim.maxBufferSize / BYTES_PER_SLOT));
        if (cap <= 0) return null;
        if (cap < TARGET_MAX_BODIES) {
          console.warn(`WGPU: device limits cap maxBodies at ${cap} ` +
            `(maxStorageBufferBindingSize ${lim.maxStorageBufferBindingSize}, ` +
            `maxBufferSize ${lim.maxBufferSize})`);
        }

        const context = canvas.getContext('webgpu');
        if (!context) return null;
        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: 'opaque' });

        this.adapter = adapter;
        this.device = device;
        this.context = context;
        this.format = format;
        this.maxBodiesCap = cap;
        return this;
      } catch (e) {
        console.warn('WGPU.boot failed:', e && e.message ? e.message : e);
        return null;
      }
    },
  };

  globalThis.WGPU = WGPU;
})();
