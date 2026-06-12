'use strict';
// Black-screen insurance: inject a mock navigator.gpu into real Chromium
// and prove that EVERY WebGPU failure mode ends with the app running in
// WebGL — never a dead page. Failure modes covered:
//   absent      - no navigator.gpu at all (the plain environment)
//   hang        - requestAdapter never resolves (boot timeout must fire)
//   nullAdapter - requestAdapter resolves null
//   deviceFail  - requestDevice rejects
//   validation  - device "works" but popErrorScope reports a WGSL error
//   frameCrash  - init passes, first frame throws -> probation reload
// Run: node test/fallback.browser.test.js

let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/tmp/node_modules/playwright')); }
const path = require('path');

let failed = false;
const check = (cond, msg, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg + (extra ? `  [${extra}]` : ''));
  if (!cond) failed = true;
};

// A generous device stub: any method exists and returns another stub, so
// agent-written init code can call whatever it likes without throwing.
// Specific behaviors are layered per failure mode.
const MOCK = (mode) => `
(() => {
  const mode = ${JSON.stringify(mode)};
  if (mode === 'absent') return;

  const anything = () => stub;
  const stub = new Proxy(function () {}, {
    get: (t, k) => {
      if (k === 'then') return undefined;          // not a thenable
      if (k === Symbol.toPrimitive) return () => 0;
      return stub;
    },
    apply: () => stub,
    construct: () => stub,
  });

  globalThis.GPUBufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8,
    UNIFORM: 64, STORAGE: 128 };
  globalThis.GPUMapMode = { READ: 1 };

  const device = {
    limits: { maxStorageBufferBindingSize: 134217728, maxBufferSize: 268435456 },
    addEventListener() {},
    pushErrorScope() {},
    popErrorScope: async () =>
      mode === 'validation' ? { message: 'mock WGSL validation error' } : null,
    queue: { writeBuffer() {}, submit() {} },
    createBuffer: () => ({ destroy() {}, mapAsync: async () => {},
      getMappedRange: () => new ArrayBuffer(16), unmap() {} }),
    createShaderModule: () => stub,
    createComputePipeline: () => ({ getBindGroupLayout: () => stub }),
    createRenderPipeline: () => ({ getBindGroupLayout: () => stub }),
    createBindGroup: () => stub,
    createBindGroupLayout: () => stub,
    createPipelineLayout: () => stub,
    createTexture: () => ({ createView: () => stub, destroy() {} }),
    createSampler: () => stub,
    createCommandEncoder: () => ({
      beginComputePass: () => ({ setPipeline() {}, setBindGroup() {},
        dispatchWorkgroups() {}, end() {} }),
      beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {},
        setVertexBuffer() {}, draw() {}, end() {} }),
      copyBufferToBuffer() {},
      finish: () => stub,
    }),
  };

  const adapter = {
    info: { vendor: 'mock' },
    isFallbackAdapter: false,
    requestDevice: async () => {
      if (mode === 'deviceFail') throw new Error('mock requestDevice failure');
      return device;
    },
  };

  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: {
      getPreferredCanvasFormat: () => 'bgra8unorm',
      requestAdapter: (opts) => {
        if (mode === 'hang') return new Promise(() => {});
        if (mode === 'nullAdapter') return Promise.resolve(null);
        return Promise.resolve(adapter);
      },
    },
  });

  // webgpu canvas context for the mock device; webgl untouched.
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...a) {
    if (type === 'webgpu') {
      return {
        canvas: this,
        configure() {},
        getCurrentTexture: () => {
          if (mode === 'frameCrash') throw new Error('mock first-frame crash');
          return { createView: () => stub };
        },
      };
    }
    return orig.call(this, type, ...a);
  };
})();`;

(async () => {
  const root = path.resolve(__dirname, '..');
  const url = 'file://' + path.join(root, 'index.html');
  const browser = await chromium.launch();

  // frameCrash needs the longest runway: probation bail -> reload -> WebGL.
  const MODES = [
    ['absent', 12000], ['nullAdapter', 12000], ['deviceFail', 12000],
    ['validation', 14000], ['hang', 18000], ['frameCrash', 20000],
  ];

  for (const [mode, waitMs] of MODES) {
    const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(MOCK(mode));
    await page.goto(url);
    // Wait until the stat line reports a running engine (it updates
    // every 400 ms once the loop is alive).
    let stat = '';
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      stat = await page.evaluate(
        () => (document.getElementById('stat') || {}).textContent || '');
      if (/bodies.*(gpu|cpu)/.test(stat)) break;
      await page.waitForTimeout(500);
    }
    const bodies = parseInt(stat.replace(/[^0-9]/g, ''), 10) || 0;
    check(/gpu|cpu/.test(stat) && !/webgpu/.test(stat),
          `${mode}: app recovers into WebGL/CPU`, stat || 'NO STAT — black screen');
    check(bodies > 10000, `${mode}: universe populated`, `${bodies} bodies`);
    await page.close();
  }

  await browser.close();
  console.log(failed ? '\nFAILED' : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})();
