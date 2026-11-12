/// <reference types="@webgpu/types" />
// The landing's hero: aurora curtains behind the hero copy (DESIGN.md → Landing). index.astro
// imports this only when the browser has WebGPU and hands it a device it requested while this
// module downloaded; everywhere else the hero keeps its CSS glow, and the page is the same.
// The shaders are plain WGSL (aurora.wgsl), so nothing is compiled to WGSL in the browser.
import shaderCode from "./aurora.wgsl?raw";

/** sRGB 0..1 from #rrggbb. */
const hex = (v: string): [number, number, number] => {
  const n = Number.parseInt(v.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** The page --bg under the curtains (so the canvas meets the page with no seam). */
const BG = hex("#050607");
/** Curtain colors: deep, body, hot core. */
const DEEP = hex("#0e4f6b");
const BODY = hex("#22d3a0");
const CORE = hex("#d6ffef");

const BRIGHTNESS = 0.95;
/** How much the curtains dim behind the copy. */
const COPY_FADE = 0.9;

const MAX_DPR = 2;
const MAX_DT = 1 / 20;
/** Longest side of the HDR target. */
const MAX_ACCUM_SIDE = 2048;
/** The bloom target is this many times smaller than the HDR target. */
const LOW_DIV = 4;
const HDR: GPUTextureFormat = "rgba16float";
/** Tap direction and spacing of the four bloom blurs, in texels. */
const BLURS: [number, number][] = [
  [1, 0],
  [0, 1],
  [3, 0],
  [0, 3],
];

// ---- curtain layouts: interpolated by the canvas aspect ----

type V4 = [number, number, number, number];
type SheetDef = { geo: V4; edge: V4; shape: V4; motion: V4; look: V4; extra: V4 };
type Layout = { sheets: SheetDef[]; milky: V4 };

/**
 * Wide landscape (the film's framing): the finely rayed curtain fans up right of
 * center, the big blurred curtain fills the right edge, a blurred fold sweeps
 * along the bottom, and the copy sits in the dark starfield at the left.
 */
const WIDE: Layout = {
  sheets: [
    // Near curtain, at focus.
    {
      geo: [1.2, -0.8, -0.27, 0.06],
      edge: [1.0, 0.12, 0.05, 0.012],
      shape: [0.8, 0.12, 0.0012, 1.3],
      motion: [0.9, 2.3, 0.025, 0.06],
      look: [45, 1.15, 3.2, 0.16],
      extra: [0.004, 0.6, 0.002, 0.03],
    },
    // A second fold of it, a little behind the focal plane.
    {
      geo: [1.15, -1.0, -0.12, 0.07],
      edge: [0.86, 0.06, 0, 0.02],
      shape: [0.75, 0.05, 0.004, 5.7],
      motion: [0.6, 1.7, 0.02, -0.07],
      look: [36, 1, 2.4, 0.22],
      extra: [0.006, 0.4, 0.006, 0.08],
    },
    // Big curtain far out of focus: a wide wall of soft bands behind and beyond the near one.
    {
      geo: [1.5, -1.4, -0.2, 0.32],
      edge: [0.66, -0.1, 0.08, 0.03],
      shape: [1.1, 0.15, 0.017, 9.1],
      motion: [0.35, 1.4, 0.012, 0.04],
      look: [11, 1.6, 0.75, 0.3],
      extra: [0.04, 0, 0, 0.2],
    },
    // Foreground fold, far out of focus: a ribbon lit along its upper edge, dark below.
    {
      geo: [1.35, -5, -0.1, 0.1],
      edge: [0.8, -0.14, 0.1, 0.015],
      shape: [0.04, 0.6, 0.035, 13.3],
      motion: [0.25, 1.2, 0.002, 0.03],
      look: [10, 0.5, 0.7, 0.35],
      extra: [0.07, 0, 0, 0.05],
    },
    // A faint, out-of-focus curtain edge at the far left.
    {
      geo: [-0.25, -1.2, -0.06, 0.2],
      edge: [0.95, 0, 0, 0.05],
      shape: [0.8, 0.04, 0.05, 17.9],
      motion: [0.4, 1, 0.005, 0.03],
      look: [4, 1, 1.2, 0.3],
      extra: [0.03, 0, 0, 0.3],
    },
  ],
  milky: [0.25, 1.05, 0.62, -0.05],
};

const SQUARE: Layout = {
  sheets: [
    {
      geo: [0.84, -0.8, -0.2, 0.06],
      edge: [0.96, 0.12, 0.05, 0.012],
      shape: [0.95, 0.2, 0.0012, 1.3],
      motion: [0.78, 2.1, 0.01, 0.09],
      look: [30, 1, 1.9, 0.16],
      extra: [0.004, 0.35, 0.004, 0],
    },
    {
      geo: [0.96, -1.0, -0.1, 0.04],
      edge: [0.86, 0.06, 0, 0.02],
      shape: [0.75, 0.1, 0.005, 5.7],
      motion: [0.6, 1.6, 0.012, -0.07],
      look: [20, 1, 1.6, 0.22],
      extra: [0.006, 0.25, 0.006, 0],
    },
    {
      geo: [1.0, -1.4, -0.16, 0.24],
      edge: [0.68, -0.1, 0.08, 0.03],
      shape: [1.1, 0.15, 0.017, 9.1],
      motion: [0.35, 1.3, 0.012, 0.04],
      look: [9, 1.6, 0.75, 0.3],
      extra: [0.04, 0, 0, 0.2],
    },
    {
      geo: [0.85, -5, -0.1, 0.08],
      edge: [0.84, -0.12, 0.1, 0.015],
      shape: [0.04, 0.5, 0.035, 13.3],
      motion: [0.25, 1.1, 0.002, 0.03],
      look: [8, 0.5, 0.7, 0.35],
      extra: [0.07, 0, 0, 0.05],
    },
    {
      geo: [-0.25, -1.2, -0.06, 0.12],
      edge: [0.95, 0, 0, 0.05],
      shape: [0.8, 0.03, 0.07, 17.9],
      motion: [0.4, 1, 0.005, 0.03],
      look: [6, 1, 1.2, 0.3],
      extra: [0.03, 0, 0, 0],
    },
  ],
  milky: [0.2, 1.05, 0.7, -0.05],
};

/** Portrait: the rays fan down to a lower edge above the copy, the blurred fold glows below it. */
const PORTRAIT: Layout = {
  sheets: [
    {
      geo: [0.3, -0.45, -0.55, 0.32],
      edge: [0.3, 0.04, 0, 0.008],
      shape: [0.5, 0.22, 0.001, 1.3],
      motion: [0.78, 2.2, 0.01, 0.09],
      look: [30, 1, 1.9, 0.14],
      extra: [0.004, 0.35, 0.004, 0],
    },
    {
      geo: [0.42, -0.6, -0.25, 0.25],
      edge: [0.26, 0.04, 0, 0.015],
      shape: [0.45, 0.1, 0.004, 5.7],
      motion: [0.6, 1.6, 0.012, -0.07],
      look: [20, 1, 1.6, 0.22],
      extra: [0.006, 0.25, 0.006, 0],
    },
    {
      geo: [0.5, -1.0, -0.05, 0.16],
      edge: [0.3, -0.05, 0.05, 0.03],
      shape: [0.4, 0.22, 0.035, 9.1],
      motion: [0.55, 1.2, 0.01, 0.05],
      look: [6, 1, 1.4, 0.22],
      extra: [0.02, 0, 0, 0],
    },
    {
      geo: [0.25, -5, -0.07, 0.07],
      edge: [0.86, -0.08, 0.1, 0.015],
      shape: [0.04, 0.4, 0.03, 13.3],
      motion: [0.25, 1.1, 0.002, 0.03],
      look: [8, 0.5, 0.7, 0.25],
      extra: [0.06, 0, 0, 0.1],
    },
    {
      geo: [-0.25, -1.2, -0.06, 0.1],
      edge: [0.5, 0, 0, 0.05],
      shape: [0.5, 0, 0.07, 17.9],
      motion: [0.4, 1, 0.005, 0.03],
      look: [6, 1, 1.2, 0.3],
      extra: [0.03, 0, 0, 0],
    },
  ],
  milky: [0.0, 0.75, 1.0, 0.65],
};

const lerp4 = (a: V4, b: V4, k: number) => a.map((v, i) => v + ((b[i] ?? v) - v) * k) as V4;
const lerpLayout = (a: Layout, b: Layout, t: number): Layout => {
  const k = Math.min(1, Math.max(0, t));
  const sk = k * k * (3 - 2 * k);
  return {
    sheets: a.sheets.map((s, i) => {
      const o = b.sheets[i] ?? s;
      return {
        geo: lerp4(s.geo, o.geo, sk),
        edge: lerp4(s.edge, o.edge, sk),
        shape: lerp4(s.shape, o.shape, sk),
        motion: lerp4(s.motion, o.motion, sk),
        look: lerp4(s.look, o.look, sk),
        extra: lerp4(s.extra, o.extra, sk),
      };
    }),
    milky: lerp4(a.milky, b.milky, sk),
  };
};

const layoutFor = (aspect: number): Layout =>
  aspect < 1.05
    ? lerpLayout(PORTRAIT, SQUARE, (aspect - 0.5) / 0.55)
    : lerpLayout(SQUARE, WIDE, (aspect - 1.05) / 0.68);

// ---- uniform layouts (WGSL `Uniforms` and `Frame`, in f32 slots) ----

const UNIFORMS_FLOATS = 136; // 544 bytes: 10 scalars, milky at slot 12, 5 sheets x 24 from slot 16
const FRAME_FLOATS = 32; // 128 bytes
const SHEET_FLOATS = 24;

/**
 * Start the aurora in `canvas`, keeping it dim behind `copy` (measured every frame).
 * Reduced motion holds a still frame; off-screen or in a hidden tab, nothing renders.
 * Any GPU failure removes the canvas, leaving the CSS glow behind it.
 */
export function startAuroraHero(
  canvas: HTMLCanvasElement,
  copy: HTMLElement,
  device: GPUDevice,
): void {
  let failed = false;
  const fail = (message: string) => {
    if (failed) return;
    failed = true;
    console.error(message);
    canvas.remove();
  };
  device.addEventListener("uncapturederror", (event) => fail(event.error.message));
  void device.lost.then((info) => {
    if (info.reason !== "destroyed") fail(`GPU device lost: ${info.message}`);
  });

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let onScreen = true;
  new IntersectionObserver(([entry]) => {
    onScreen = entry?.isIntersecting ?? true;
  }).observe(canvas);

  const format = navigator.gpu.getPreferredCanvasFormat();
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("no WebGPU canvas context");
  context.configure({ device, format, alphaMode: "premultiplied" });

  // ---- resources ----

  const uniformData = new Float32Array(UNIFORMS_FLOATS);
  const frameData = new Float32Array(FRAME_FLOATS);
  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const frameBuffer = device.createBuffer({
    size: frameData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  /** 32^3 perlin gradients, vec3f with a 16-byte stride. */
  const gradients = device.createBuffer({ size: 32 ** 3 * 16, usage: GPUBufferUsage.STORAGE });
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  const FRAGMENT = GPUShaderStage.FRAGMENT;
  const sharedLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: FRAGMENT, buffer: { type: "uniform" } },
      { binding: 2, visibility: FRAGMENT, sampler: { type: "filtering" } },
      { binding: 3, visibility: FRAGMENT, buffer: { type: "read-only-storage" } },
    ],
  });
  const fillLayout = device.createBindGroupLayout({
    entries: [{ binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }],
  });
  const srcLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: FRAGMENT, texture: {} }],
  });
  const compositeLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: FRAGMENT, texture: {} },
      { binding: 1, visibility: FRAGMENT, texture: {} },
    ],
  });
  const shared = device.createBindGroup({
    layout: sharedLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: frameBuffer } },
      { binding: 2, resource: sampler },
      { binding: 3, resource: { buffer: gradients } },
    ],
  });

  // ---- pipelines: compiled in parallel, off the GPU process's main thread ----

  const module = device.createShaderModule({ code: shaderCode });
  const pass = (
    entryPoint: string,
    groups: GPUBindGroupLayout[],
    target: GPUTextureFormat,
    constants?: Record<string, number>,
  ) =>
    device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: groups }),
      vertex: { module, entryPoint: "fullScreenTriangle" },
      fragment: { module, entryPoint, constants, targets: [{ format: target }] },
    });
  // The curtain compiles longest, so it starts first.
  const pipelines = Promise.all([
    pass("curtainFragment", [sharedLayout], HDR),
    pass("compositeFragment", [sharedLayout, compositeLayout], format),
    pass("lowFragment", [sharedLayout, srcLayout], HDR),
    Promise.all(
      BLURS.map(([blurX, blurY]) => pass("blur", [sharedLayout, srcLayout], HDR, { blurX, blurY })),
    ),
    device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [fillLayout] }),
      compute: { module, entryPoint: "fill" },
    }),
  ]);

  // ---- size-dependent targets ----

  let width = 0;
  let height = 0;
  const makeTargets = (w: number, h: number) => {
    const fit = Math.min(1, MAX_ACCUM_SIDE / Math.max(w, h));
    const size: [number, number] = [
      Math.max(1, Math.round(w * fit)),
      Math.max(1, Math.round(h * fit)),
    ];
    const lowSize: [number, number] = [
      Math.max(1, Math.ceil(size[0] / LOW_DIV)),
      Math.max(1, Math.ceil(size[1] / LOW_DIV)),
    ];
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    const accum = device.createTexture({ size, format: HDR, usage });
    const lowA = device.createTexture({ size: lowSize, format: HDR, usage });
    const lowB = device.createTexture({ size: lowSize, format: HDR, usage });
    const src = (texture: GPUTexture) =>
      device.createBindGroup({
        layout: srcLayout,
        entries: [{ binding: 0, resource: texture.createView() }],
      });
    return {
      size,
      textures: [accum, lowA, lowB],
      accumView: accum.createView(),
      lowAView: lowA.createView(),
      lowBView: lowB.createView(),
      accumGroup: src(accum),
      lowAGroup: src(lowA),
      lowBGroup: src(lowB),
      compositeGroup: device.createBindGroup({
        layout: compositeLayout,
        entries: [
          { binding: 0, resource: accum.createView() },
          { binding: 1, resource: lowA.createView() },
        ],
      }),
    };
  };
  let targets: ReturnType<typeof makeTargets> | null = null;

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const maxSize = device.limits.maxTextureDimension2D;
    const w = Math.max(1, Math.min(maxSize, Math.round(canvas.clientWidth * dpr)));
    const h = Math.max(1, Math.min(maxSize, Math.round(canvas.clientHeight * dpr)));
    if (targets && w === width && h === height) return;
    width = w;
    height = h;
    canvas.width = w;
    canvas.height = h;
    if (targets) for (const t of targets.textures) t.destroy();
    targets = makeTargets(w, h);
  };

  // ---- the copy block, in canvas UV ----

  const copyRect: [number, number, number, number] = [0, 0, 0, 0];
  const range = document.createRange();
  /**
   * Bounds of the copy's actual text and buttons, not its container: block
   * elements stretch to their max-width even when the text stops short.
   */
  const measureCopy = () => {
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const child of copy.children) {
      range.selectNodeContents(child);
      const r = range.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (!Number.isFinite(left)) return;
    const box = canvas.getBoundingClientRect();
    copyRect[0] = (left - box.left) / box.width;
    copyRect[1] = (top - box.top) / box.height;
    copyRect[2] = (right - box.left) / box.width;
    copyRect[3] = (bottom - box.top) / box.height;
  };

  // ---- per-frame uniforms ----

  frameData.set(BG, 16);
  frameData.set(DEEP, 20);
  frameData.set(BODY, 24);
  frameData.set(CORE, 28);
  uniformData.set([BRIGHTNESS, 1, 1, 1, 1, COPY_FADE], 2); // brightness, rays, dof, stars, bloom, copyFade
  const uniformInts = new Uint32Array(uniformData.buffer);

  const writeUniforms = (time: number, dt: number) => {
    if (!targets) return;
    const pixelRatio = width / Math.max(canvas.clientWidth, 1);
    frameData[0] = width;
    frameData[1] = height;
    frameData[2] = pixelRatio;
    frameData.set(copyRect, 4);
    frameData[8] = time;
    frameData[9] = dt;
    device.queue.writeBuffer(frameBuffer, 0, frameData);

    const aspect = (canvas.clientWidth || width) / (canvas.clientHeight || height);
    const layout = layoutFor(aspect);
    uniformData[0] = time;
    uniformData[1] = aspect;
    uniformData[8] = 1 / targets.size[1];
    uniformInts[9] = layout.sheets.length;
    uniformData.set(layout.milky, 12);
    layout.sheets.forEach((s, i) => {
      const at = 16 + i * SHEET_FLOATS;
      uniformData.set(s.geo, at);
      uniformData.set(s.edge, at + 4);
      uniformData.set(s.shape, at + 8);
      uniformData.set(s.motion, at + 12);
      uniformData.set(s.look, at + 16);
      uniformData.set(s.extra, at + 20);
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);
  };

  // ---- the loop ----

  let time = 0;
  let lastNow = 0;
  /** what the held still frame was drawn at, so reduced motion redraws only when that changes */
  let stillKey = "";

  void pipelines.then(
    ([curtain, composite, low, blurs, fill]) => {
      const encoder = device.createCommandEncoder();
      const compute = encoder.beginComputePass();
      compute.setPipeline(fill);
      compute.setBindGroup(
        0,
        device.createBindGroup({
          layout: fillLayout,
          entries: [{ binding: 4, resource: { buffer: gradients } }],
        }),
      );
      compute.dispatchWorkgroups(4, 4, 8);
      compute.end();
      device.queue.submit([encoder.finish()]);

      const draw = (
        view: GPUTextureView,
        pipeline: GPURenderPipeline,
        input: GPUBindGroup | null,
        encoder: GPUCommandEncoder,
      ) => {
        const p = encoder.beginRenderPass({
          colorAttachments: [{ view, loadOp: "clear", storeOp: "store" }],
        });
        p.setPipeline(pipeline);
        p.setBindGroup(0, shared);
        if (input) p.setBindGroup(1, input);
        p.draw(3);
        p.end();
      };

      const loop = (now: number) => {
        requestAnimationFrame(loop);
        const realDt = lastNow === 0 ? 1 / 60 : Math.min((now - lastNow) / 1000, 0.25);
        lastNow = now;
        if (failed || !onScreen || document.hidden) return;
        resize();
        const paused = reduced.matches;
        const dt = paused ? 0 : Math.min(realDt, MAX_DT);
        time += dt;

        measureCopy();
        // Paused (reduced motion): every frame would come out the same, and the canvas keeps showing
        // the last one it presented. Draw again only when the size or the copy's box moves.
        if (paused) {
          const key = `${width}x${height}:${copyRect.join(",")}`;
          if (key === stillKey) return;
          stillKey = key;
        } else {
          stillKey = "";
        }
        if (!targets) return;
        writeUniforms(time, dt);

        const t = targets;
        const encoder = device.createCommandEncoder();
        draw(t.accumView, curtain, null, encoder);
        draw(t.lowAView, low, t.accumGroup, encoder);
        blurs.forEach((blur, k) => {
          const toB = k % 2 === 0;
          draw(toB ? t.lowBView : t.lowAView, blur, toB ? t.lowAGroup : t.lowBGroup, encoder);
        });
        draw(context.getCurrentTexture().createView(), composite, t.compositeGroup, encoder);
        device.queue.submit([encoder.finish()]);
      };
      requestAnimationFrame(loop);
    },
    (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
  );
}
