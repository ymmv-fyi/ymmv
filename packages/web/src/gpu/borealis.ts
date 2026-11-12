// @ts-nocheck -- TypeGPU shader code uses vector operators (`a - b` on vectors), which need the
// tsover compiler the TypeGPU lab builds with; plain TypeScript rejects them. unplugin-typegpu
// compiles these functions to WGSL at build time. Edit in the lab and copy here.

import { perlin3d, randf } from "@typegpu/noise";
import { common, d, std, tgpu } from "typegpu";
import { ditherNoise, linearToOklab, oklabToLinear, toLinear, toSrgb } from "./color.ts";
import { copyMask } from "./copy-mask.ts";
import { defineConcept } from "./types.ts";

// ---------------------------------------------------------------------------
// Aurora curtains seen from below on a fast lens.
//
// Screen space is in screen-height units ("sh"): p = (uv.x * aspect, uv.y).
// Every curtain is a sheet of vertical rays. Looking up, vertical lines
// converge on a vanishing point above the frame, so each sheet has its own
// point `vp` and a fan coordinate s = (p.x - vp.x) / (p.y - vp.y): constant
// along every screen line through vp. Normalized across the sheet that's u.
//
// A fold in the sheet packs more of it into the same screen width, so rays
// bunch up and the light piles up there: the curtain parameter is warped,
// uf = u + a sin(k u - w t) / k, and brightness scales with duf/du.
//
// Depth of field is analytic: each sheet has a circle of confusion, and its
// rays (Gaussian lines) and lower edge are widened by it, so the far curtain,
// the foreground fold and the near curtain's soft parts are true lens blurs
// of the same structure, at full resolution, with no blur passes.
// ---------------------------------------------------------------------------

const MAX_SHEETS = 5;
/** Longest side of the HDR target. */
const MAX_ACCUM_SIDE = 2048;
/** The bloom target is this many times smaller than the HDR target. */
const LOW_DIV = 4;
const HDR = "rgba16float";
/** Perlin gradient cache; sampling wraps at this size. */
const NOISE_CACHE = 32;
const TAU = 6.2831853;

const Sheet = d.struct({
  /** Vanishing point (xy, sh), fan range s0, s1. */
  geo: d.vec4f,
  /** Lower edge: screen y at the middle, tilt across the sheet, sag, softness (sh). */
  edge: d.vec4f,
  /** Upward decay length (sh), intensity, circle of confusion (sh), seed. */
  shape: d.vec4f,
  /** Fold amount (0..1), folds across, ray sway (s units), fold drift speed. */
  motion: d.vec4f,
  /** Coarse ray count across the sheet, ray contrast, patch contrast, side feather (u). */
  look: d.vec4f,
  /** Glow below the lower edge (sh), skirt flare, extra blur toward the top (sh), right side feather (u). */
  extra: d.vec4f,
});

const Uniforms = d.struct({
  time: d.f32,
  aspect: d.f32,
  brightness: d.f32,
  rays: d.f32,
  dof: d.f32,
  stars: d.f32,
  bloom: d.f32,
  copyFade: d.f32,
  /** One HDR-target pixel, in sh. */
  pix: d.f32,
  sheetCount: d.u32,
  /** Milky Way axis: start (xy, uv), end (zw, uv). */
  milky: d.vec4f,
  sheets: d.arrayOf(Sheet, MAX_SHEETS),
});

const srcLayout = tgpu.bindGroupLayout({
  src: { texture: d.texture2d(d.f32) },
});

const compositeLayout = tgpu.bindGroupLayout({
  accum: { texture: d.texture2d(d.f32) },
  low: { texture: d.texture2d(d.f32) },
});

/** PCG-style integer hash. */
const hashU = tgpu.fn(
  [d.u32],
  d.u32,
)((v) => {
  "use gpu";
  const s = v * 747796405 + 2891336453;
  const w = ((s >>> ((s >>> 28) + 4)) ^ s) * 277803737;
  return (w >>> 22) ^ w;
});

const unit = tgpu.fn(
  [d.u32],
  d.f32,
)((h) => {
  "use gpu";
  return d.f32(h >>> 8) / 16777216;
});

/** Highlight-only filmic shoulder: identity below the knee, so the palette bg survives exactly. */
const shoulder = (c: d.v3f, knee: number) => {
  "use gpu";
  const k = d.vec3f(knee);
  const room = 1 - knee;
  const over = std.max(c - k, d.vec3f());
  const compressed = k + (1 - std.exp(over * (-1 / room))) * room;
  return std.select(compressed, c, std.le(c, k));
};

/** Compress by the brightest channel so hot lime stays saturated; a little per-channel bleach. */
const tonemap = (c: d.v3f, knee: number) => {
  "use gpu";
  const m = std.max(c.x, std.max(c.y, c.z));
  const mm = shoulder(d.vec3f(m), knee).x;
  const kept = c * (mm / std.max(m, 1e-5));
  return std.mix(kept, shoulder(c, knee), 0.2);
};

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

const lerp4 = (a: V4, b: V4, k: number) => a.map((v, i) => v + (b[i]! - v) * k) as V4;
const lerpLayout = (a: Layout, b: Layout, t: number): Layout => {
  const k = Math.min(1, Math.max(0, t));
  const sk = k * k * (3 - 2 * k);
  return {
    sheets: a.sheets.map((s, i) => {
      const o = b.sheets[i]!;
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

export default defineConcept({
  id: "borealis",
  name: "Borealis",
  blurb:
    "Aurora curtains seen from below on a fast lens: one folded sheet of fine converging rays at the focal plane, huge soft curtains and a fold far out of focus, and a quiet starfield for the copy.",
  order: 11,
  palette: "Borealis",
  params: {
    brightness: {
      type: "number",
      label: "curtain brightness",
      value: 1,
      min: 0,
      max: 2,
      step: 0.01,
    },
    rays: { type: "number", label: "ray detail", value: 1, min: 0, max: 2, step: 0.01 },
    speed: { type: "number", label: "motion speed", value: 1, min: 0, max: 3, step: 0.01 },
    dof: { type: "number", label: "depth of field", value: 1, min: 0, max: 2, step: 0.01 },
    stars: { type: "number", value: 1, min: 0, max: 2, step: 0.01 },
    bloom: { type: "number", value: 1, min: 0, max: 2, step: 0.01 },
    copyFade: { type: "number", label: "copy fade", value: 0.85, min: 0, max: 1, step: 0.01 },
  },

  create({ root, frame, format, context, canvas, width, height }, params) {
    const uniforms = root.createUniform(Uniforms);
    const noiseCache = perlin3d.staticCache({ root, size: d.vec3u(NOISE_CACHE) });
    const noiseRoot = root.pipe(noiseCache.inject());
    const sampler = root.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // ---- rays ----

    /**
     * One octave of rays at jittered positions, at most one per cell: hair-thin to
     * broad, some cells empty, each ray wavering sideways more the higher it goes,
     * fading in and out along its length (brightest low down), breaking into dashes
     * near the lower edge, with a soft smeared halo like a long exposure. `foot` is
     * the pixel footprint plus lens blur, in cells: rays are widened by it (keeping
     * their energy) and the octave fades to its mean once its cells get too small to
     * resolve. `vblur` is the lens blur along the rays (sh), which low-passes the
     * changes along their length. Normalized to a mean of about 1.
     */
    const rayOctave = tgpu.fn(
      [d.f32, d.f32, d.f32, d.u32, d.f32, d.f32, d.f32, d.f32],
      d.f32,
    )((x, foot, width, seed, h, t, jag, vblur) => {
      "use gpu";
      const base = std.floor(x);
      const hp = std.max(h, 0);
      let sum = d.f32(0);
      for (let j = -1; j <= 1; j++) {
        const i = base + d.f32(j);
        const h1 = hashU(d.u32(i + 65536) ^ seed);
        const h2 = hashU(h1);
        const h3 = hashU(h2);
        const h4 = hashU(h3);
        const r1 = unit(h1);
        const r2 = unit(h2);
        const r3 = unit(h3);
        const r4 = unit(h4);
        // A gentle sideways waver that grows with height.
        const fw = 3 + 7 * r1;
        const wob =
          0.27 *
          std.min(0.12 + hp, 1) *
          std.sin(h * fw + t * (0.08 + 0.2 * r3) + r2 * 31) *
          std.exp(-2 * fw * fw * vblur * vblur);
        const c = i + 0.5 + (r1 - 0.5) * 0.7 + wob;
        // Hair-thin to broad; broad ones are dimmer, so they read as glow, thin ones as threads.
        const w = width * (0.18 + 1.9 * r2 * r2 * r2);
        const we = std.sqrt(w * w + foot * foot);
        // Brightness along the ray: two waves with random phases, fading out fully in places.
        const fa = 2 + 7 * r3;
        const fb = 9 + 14 * r1;
        const wa =
          std.sin(h * fa + t * (0.12 + 0.4 * r2) + r1 * 40) * std.exp(-2 * fa * fa * vblur * vblur);
        const wb =
          std.sin(h * fb - t * (0.2 + 0.3 * r3) + r2 * 23) * std.exp(-2 * fb * fb * vblur * vblur);
        // Far out of focus, the light reads as soft bands: only a gentle variation survives.
        const keepAlong = 1 - 0.65 * std.smoothstep(0.004, 0.02, vblur);
        const along = std.saturate(0.5 + keepAlong * (0.65 * wa + 0.35 * wb));
        const low = 0.5 + 0.9 * std.exp(-hp / 0.25);
        // Near the lower edge rays break up into bright dashes.
        const fd = 22 + 30 * r2;
        const dash = std.smoothstep(-0.4, 0.9, std.sin(h * fd + r1 * 17 + t * (0.3 + 0.4 * r3)));
        const near = std.exp(-hp / 0.08) * 0.75 * std.exp(-2 * fd * fd * vblur * vblur);
        const seg = std.mix(1, dash * 1.5, near);
        // Ragged lower ends, like flames along the bottom of the curtain.
        const end = std.smoothstep(-0.01 - vblur, 0.025 + vblur, h - (r2 - 0.35) * jag);
        const present = std.step(0.2, r4);
        const amp =
          ((0.3 + 1.5 * r3 * r3) * present * along * low * seg * end * (w / we)) /
          (0.6 + (0.4 * w) / width);
        const dx = x - c;
        const core = std.exp((dx * dx) / (-2 * we * we));
        const halo = std.exp((dx * dx) / (-9.7 * we * we));
        sum += amp * (core + 0.1 * halo);
      }
      // E[amp] ~ 0.8 * 0.8 * 0.5 * 0.75 / 0.9, E[w] ~ 0.78 width, halo adds 0.35.
      const mean = 0.27 * 0.66 * width * 2.5066 * 1.22;
      return std.mix(sum / mean, 1, std.smoothstep(0.22, 0.55, foot));
    });

    // ---- sheets ----

    /** Emission of one curtain sheet at p (sh), linear max-channel units. */
    const sheetLight = tgpu.fn(
      [d.vec2f, d.u32, d.f32],
      d.f32,
    )((p, idx, pix) => {
      "use gpu";
      const u = uniforms.$;
      const sh = u.sheets[idx]!;
      const t = u.time;
      const dy = p.y - sh.geo.y;
      if (dy < 0.05 || sh.shape.y < 1e-4) {
        return 0;
      }
      // The skirt flares out toward the bottom, so rays bow outward as they descend.
      const fl = std.max(dy - 1.1, 0);
      const flare = 1 + sh.extra.y * fl * fl;
      const s = (p.x - sh.geo.x) / dy / flare;
      const seed = sh.shape.w;

      // A slow ripple travels along the curtain; it varies with height, so rays curve.
      const sway =
        sh.motion.z *
        (std.sin(s * 7 + dy * 1.6 - t * 0.21 + seed) +
          0.6 * std.sin(s * 19 - dy * 2.9 + t * 0.17 + seed * 1.7));
      const span = sh.geo.w - sh.geo.z;
      const u0 = (s + sway - sh.geo.z) / span;

      // Folds: rays bunch and brighten where the sheet turns edge-on.
      const ff = sh.motion.y * TAU;
      const ph = u0 * ff - t * sh.motion.w * TAU + seed * 3.1;
      const ph2 = u0 * ff * 2.3 + t * sh.motion.w * 4.1 + seed * 1.3;
      const fa = sh.motion.x;
      const uf = u0 + (fa * std.sin(ph)) / ff + (fa * 0.25 * std.sin(ph2)) / (ff * 2.3);
      const dens = std.max(1 + fa * std.cos(ph) + fa * 0.25 * std.cos(ph2), 0.05);

      // Footprints across the sheet, in uf units: one pixel, and the lens blur.
      const stretch = (std.sqrt(1 + s * s) / dy / flare / span) * dens;
      // Focus falls off a little toward the top of the frame.
      const coc = (sh.shape.z + sh.extra.z * (1 - p.y) * (1 - p.y)) * u.dof;
      const pixU = pix * stretch;
      const cocU = coc * stretch;

      // Lower edge, rippling, with the light strongest just above it and fading upward.
      const ye =
        sh.edge.x +
        sh.edge.y * (uf - 0.5) +
        sh.edge.z * (uf - 0.5) * (uf - 0.5) +
        // Narrow frames show less of the curtain, so the same ripple would look huge there.
        std.min(sh.shape.x * 0.3, 0.03) *
          (0.35 + 0.65 * std.smoothstep(0.5, 1.3, u.aspect)) *
          (std.sin(uf * 7.3 - t * 0.21 + seed) + 0.4 * std.sin(uf * 17.1 + t * 0.37 + seed * 2));
      const h = ye - p.y;
      const soft = sh.edge.w + coc + pix;
      // Out-of-focus sheets also glow a little below their edge (continuous at h = 0).
      const below = std.min(h, 0) / (sh.extra.x + soft);
      const rise = std.max(
        std.smoothstep(-soft, soft * 0.5, h),
        0.74 * std.exp(below * (1 - 0.5 * below)),
      );
      const hp = std.max(h, 0);
      const L = sh.shape.x;
      const vert = rise * std.exp(-hp / L) * (0.8 + 0.2 * std.exp(-hp / (L * 0.12 + soft)));

      // Sides: the body fades in over the feather; a few sparse rays reach beyond it.
      const sf = sh.look.w + cocU;
      const sr = sh.extra.w + cocU + pixU;
      const body = std.smoothstep(0, sf, uf) * std.smoothstep(1, 1 - sr, uf);
      // Only sheets near focus show them; out of focus they'd blur into a stray glow.
      const hair =
        std.smoothstep(-0.3, 0.02, uf) *
        std.smoothstep(1 + sr, 1 - sr, uf) *
        (1 - std.smoothstep(0.003, 0.012, coc));

      // Most pixels are outside most sheets: skip the rays and noise there.
      const env = sh.shape.y * u.brightness * std.pow(dens, 1.4) * vert * std.max(body, hair * 0.3);
      if (env * std.exp(sh.look.z * 0.7) * 6 < 0.0004) {
        return 0;
      }

      // Rays: three octaves, finer ones fading out where they can't be resolved.
      const iseed = d.u32(seed * 1000);
      let rays = d.f32(0);
      let coarse = d.f32(1);
      for (let k = 0; k < 3; k++) {
        const fk = d.f32(k);
        const n = sh.look.x * std.pow(2.55, fk);
        const foot = n * std.sqrt(pixU * pixU * 0.2 + cocU * cocU);
        let r = d.f32(1);
        if (foot < 0.55) {
          // Warp the cells so rays clump together with gaps between.
          const xn = uf * n;
          const xw =
            xn +
            0.9 * std.sin(xn * 0.31 + seed * 5 + fk) +
            0.55 * std.sin(xn * 0.83 + seed * 2.3 - fk);
          r = rayOctave(
            xw,
            foot,
            0.085 - 0.01 * fk,
            iseed + d.u32(k) * 7919,
            h,
            t,
            0.06 * (1 - fk * 0.4) * (1 - std.smoothstep(0.003, 0.015, coc)),
            coc,
          );
        }
        if (k === 0) {
          coarse = r;
        }
        rays += r * std.pow(0.2, fk);
      }
      rays = rays / 1.24;
      const contrast = sh.look.y * u.rays;
      const R = std.max(std.mix(1, rays, contrast), 0);
      const hairR = std.max(std.mix(1, coarse, std.min(contrast, 1)), 0);

      // Large patches of brightness drift along the curtain; finer ones only where sharp.
      const n1 = perlin3d.sample(
        d.vec3f(uf * 2.6 - t * 0.035 + seed * 7.1, h * 1.1 + seed, t * 0.05),
      );
      const n2 = perlin3d.sample(
        d.vec3f(uf * 7.5 + seed * 3.3 - t * 0.06, h * 2.6, t * 0.08 + 4.1),
      );
      const sharp = std.exp(-cocU * 10);
      const pn = n1 * 0.9 + n2 * 0.45 * sharp;
      // Hot cores: mottled patches inside the lower and middle body, not at the very edge.
      const mid = std.smoothstep(0.02, 0.14, h) * std.exp(-hp / 0.7);
      const hot = std.smoothstep(0.1, 0.55, pn) * mid;
      const patch =
        std.exp(sh.look.z * 0.75 * pn) *
        (1 + 3.6 * hot * std.min(sh.look.z / 3, 1) * (1 - std.smoothstep(0.004, 0.012, coc)));
      // Long streaks: groups of rays fade in and out along their length.
      const n4 = perlin3d.sample(
        d.vec3f(uf * sh.look.x * 0.35 + seed * 1.9, h * 2.4 - t * 0.03, t * 0.07 + 2.2),
      );
      const streak = std.exp(1.3 * n4 * std.min(u.rays, 1.5) * sharp);
      // Streaky, wispy texture in the glow between the rays.
      let wisp = d.f32(1);
      if (sharp > 0.05) {
        const n3 = perlin3d.sample(d.vec3f(uf * 21 + seed, h * 1.7 - t * 0.04, t * 0.06 + 9.3));
        wisp = std.max(1 + n3 * 1.3 * sharp * std.min(u.rays, 1.5), 0.1);
      }

      // The patches mostly brighten the rays, so hot cores are striated too.
      const shape =
        body * (0.07 * wisp * std.sqrt(patch) + 0.93 * R * streak * patch) +
        std.max(hair - body, 0) * hairR * streak * patch * 0.3;
      return (env / std.max(body, hair * 0.3)) * shape;
    });

    /** Palette ramp in Oklab: deep -> body -> hot core. Hue only, peak channel 1. */
    const ramp = (heat: number) => {
      "use gpu";
      const f = frame.$;
      const c0 = linearToOklab(toLinear(f.c0));
      const c1 = linearToOklab(toLinear(f.c1));
      const c2 = linearToOklab(toLinear(f.c2));
      let lab = std.mix(c0, c1, std.smoothstep(0, 0.5, heat));
      lab = std.mix(lab, c2, std.smoothstep(0.5, 1, heat));
      const rgb = std.max(oklabToLinear(lab), d.vec3f());
      return rgb / std.max(std.max(rgb.x, std.max(rgb.y, rgb.z)), 1e-4);
    };

    const curtainFragment = tgpu.fragmentFn({
      in: { uv: d.vec2f },
      out: d.vec4f,
    })((input) => {
      "use gpu";
      const u = uniforms.$;
      const f = frame.$;
      const p = input.uv * d.vec2f(u.aspect, 1);
      const pix = u.pix;
      let total = d.f32(0);
      for (let i = d.u32(0); i < u.sheetCount; i++) {
        total += sheetLight(p, i, pix);
      }
      // Reshaped so the fade stays full over the copy but falls off sooner around it: on
      // portrait the curtain's lower edge sits just above the copy.
      const mask = std.smoothstep(0.3, 0.95, copyMask(input.uv, f.copyRect, u.aspect));
      total = total * (1 - mask * u.copyFade);
      // Faint is deep green, bright is the hot lime core.
      const heat = std.saturate((std.log2(std.max(total, 1e-6)) + 6.6) / 6.6);
      return d.vec4f(ramp(heat) * total, total);
    });

    // ---- low-res pass: bloom source and the Milky Way haze ----

    const brightPass = (c: d.v3f) => {
      "use gpu";
      const m = std.max(c.x, std.max(c.y, c.z));
      return c * (std.max(m - 0.5, 0) / std.max(m, 1e-4)) + c * 0.04;
    };

    const lowFragment = tgpu.fragmentFn({
      in: { uv: d.vec2f },
      out: d.vec4f,
    })((input) => {
      "use gpu";
      const u = uniforms.$;
      const f = frame.$;
      const uv = input.uv;
      const texel = 1 / d.vec2f(std.textureDimensions(srcLayout.$.src));
      const t0 = std.textureSample(srcLayout.$.src, sampler.$, uv + texel * d.vec2f(-1, -1)).xyz;
      const t1 = std.textureSample(srcLayout.$.src, sampler.$, uv + texel * d.vec2f(1, -1)).xyz;
      const t2 = std.textureSample(srcLayout.$.src, sampler.$, uv + texel * d.vec2f(-1, 1)).xyz;
      const t3 = std.textureSample(srcLayout.$.src, sampler.$, uv + texel * d.vec2f(1, 1)).xyz;
      const bright =
        (brightPass(t0) + brightPass(t1) + brightPass(t2) + brightPass(t3)) * (0.25 * u.bloom);

      // A faint, mottled Milky Way band through the dark sky.
      const s = d.vec2f(u.aspect, 1);
      const a = u.milky.xy * s;
      const ab = u.milky.zw * s - a;
      const q = uv * s;
      const tt = std.saturate(std.dot(q - a, ab) / std.dot(ab, ab));
      const dist = std.length(q - (a + ab * tt));
      const m1 = perlin3d.sample(d.vec3f(q * 3.1, 1.7));
      const m2 = perlin3d.sample(d.vec3f(q * 9.3 + 4.1, 2.9));
      const band = std.exp(-(dist * dist) / 0.012) * std.saturate(0.55 + 0.8 * m1 + 0.4 * m2);
      const keep = 1 - copyMask(uv, f.copyRect, u.aspect) * u.copyFade * 0.6;
      const milky =
        std.mix(toLinear(f.c0), d.vec3f(0.5, 0.55, 0.5), 0.5) * (band * 0.006 * u.stars * keep);
      return d.vec4f(bright + milky, 1);
    });

    /** Separable 9-tap Gaussian (five bilinear fetches), with a tap spacing. */
    const makeBlur = (dx: number, dy: number) =>
      tgpu.fragmentFn({
        in: { uv: d.vec2f },
        out: d.vec4f,
      })((input) => {
        "use gpu";
        const texel = 1 / d.vec2f(std.textureDimensions(srcLayout.$.src));
        const step = d.vec2f(dx, dy) * texel;
        const a = std.textureSample(srcLayout.$.src, sampler.$, input.uv) * 0.227027;
        const b =
          std.textureSample(srcLayout.$.src, sampler.$, input.uv + step * 1.384615) * 0.316216;
        const c =
          std.textureSample(srcLayout.$.src, sampler.$, input.uv - step * 1.384615) * 0.316216;
        const e =
          std.textureSample(srcLayout.$.src, sampler.$, input.uv + step * 3.230769) * 0.07027;
        const g =
          std.textureSample(srcLayout.$.src, sampler.$, input.uv - step * 3.230769) * 0.07027;
        return a + b + c + e + g;
      });

    // ---- composite ----

    /** Tiny sharp stars on a hashed grid, a few faintly tinted. Static. */
    const starField = (px: d.v2f, pr: number) => {
      "use gpu";
      const cell = 11 * pr;
      const q = px / cell;
      const id = std.floor(q);
      const h1 = hashU(d.u32(id.x + 4096) * 73856093 + d.u32(id.y + 4096) * 19349663);
      const h2 = hashU(h1);
      const h3 = hashU(h2);
      const h4 = hashU(h3);
      let col = d.vec3f();
      if (unit(h1) < 0.14) {
        const pos = id + 0.2 + d.vec2f(unit(h2), unit(h3)) * 0.6;
        const dd = (q - pos) * cell;
        const mag = std.pow(unit(h4), 7);
        const r = (0.5 + 0.45 * mag) * pr;
        const v = std.exp(-std.dot(dd, dd) / (2 * r * r)) * (0.005 + 0.35 * mag);
        const tint = unit(hashU(h4));
        let c = d.vec3f(1, 0.97, 0.92);
        if (tint < 0.1) {
          c = d.vec3f(1, 0.72, 0.5);
        }
        if (tint > 0.95) {
          c = d.vec3f(0.7, 0.82, 1);
        }
        col = c * v;
      }
      return col;
    };

    const compositeFragment = tgpu.fragmentFn({
      in: { uv: d.vec2f, pos: d.builtin.position },
      out: d.vec4f,
    })((input) => {
      "use gpu";
      const f = frame.$;
      const u = uniforms.$;
      const uv = input.uv;
      const acc = std.textureSample(compositeLayout.$.accum, sampler.$, uv);
      const low = std.textureSample(compositeLayout.$.low, sampler.$, uv).xyz;

      const bg = toLinear(f.bg);
      const lum = std.dot(bg, d.vec3f(0.2126, 0.7152, 0.0722));
      const light = std.smoothstep(0.15, 0.5, lum);
      const mask = copyMask(uv, f.copyRect, u.aspect);

      // Stars sit behind the emission: faint, not gone, under bright curtain light.
      const curtainLum = std.max(acc.w, 0);
      const behind = 0.1 + 0.9 * std.exp(-curtainLum * 40);
      const stars =
        starField(input.pos.xy, f.pixelRatio) * (u.stars * behind * (1 - mask * u.copyFade * 0.5));

      const vq = (uv - 0.5) * d.vec2f(1, 0.9) * 2;
      const vig = 1 - 0.25 * std.smoothstep(0.35, 1.5, std.length(vq));

      randf.seed3(d.vec3f(input.pos.xy, std.fract(f.time * 7.3) * 100));
      const grain = randf.sample() + randf.sample() - 1;

      const emitted = (acc.xyz + low + stars) * vig;
      const glowLum = std.dot(emitted, d.vec3f(0.2126, 0.7152, 0.0722));
      let dark =
        bg + emitted * (1 + grain * (0.08 + 0.14 * std.sqrt(std.min(glowLum, 1)))) + grain * 0.0016;
      const knee = std.max(0.6, std.max(bg.x, std.max(bg.y, bg.z)) + 0.02);
      dark = tonemap(std.max(dark, d.vec3f()), std.min(knee, 0.97));

      // Light palettes: no headroom to add light, so the curtains become soft, darker
      // bands of the palette's deep and body colors laid over the paper.
      const c0 = toLinear(f.c0);
      const c1 = toLinear(f.c1);
      const inkLab = std.mix(linearToOklab(c0), linearToOklab(c1), 0.45);
      const ink = std.max(oklabToLinear(d.vec3f(inkLab.x * 0.9, inkLab.yz)), d.vec3f());
      const amt = acc.w + std.max(low.x, std.max(low.y, low.z)) * 0.5;
      const cover = (1 - std.exp(amt * -2.6)) * 0.62;
      const day = std.mix(bg, ink, cover * vig) + grain * 0.006;

      let out = toSrgb(std.mix(dark, day, light));
      out = out + (ditherNoise(input.pos.xy) - 0.5) / 255;
      return d.vec4f(out, 1);
    });

    // ---- pipelines ----

    const curtainPipeline = noiseRoot.createRenderPipeline({
      vertex: common.fullScreenTriangle,
      fragment: curtainFragment,
      targets: { format: HDR },
    });
    const lowPipeline = noiseRoot.createRenderPipeline({
      vertex: common.fullScreenTriangle,
      fragment: lowFragment,
      targets: { format: HDR },
    });
    const blurs = [
      [1, 0],
      [0, 1],
      [3, 0],
      [0, 3],
    ].map(([x, y]) =>
      root.createRenderPipeline({
        vertex: common.fullScreenTriangle,
        fragment: makeBlur(x!, y!),
        targets: { format: HDR },
      }),
    );
    const compositePipeline = root.createRenderPipeline({
      vertex: common.fullScreenTriangle,
      fragment: compositeFragment,
      targets: { format },
    });

    // ---- size-dependent targets ----

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
      const accum = root.createTexture({ size, format: HDR }).$usage("sampled", "render");
      const lowA = root.createTexture({ size: lowSize, format: HDR }).$usage("sampled", "render");
      const lowB = root.createTexture({ size: lowSize, format: HDR }).$usage("sampled", "render");
      return {
        size,
        textures: [accum, lowA, lowB],
        accumView: accum.createView("render"),
        lowAView: lowA.createView("render"),
        lowBView: lowB.createView("render"),
        accumGroup: root.createBindGroup(srcLayout, { src: accum }),
        lowAGroup: root.createBindGroup(srcLayout, { src: lowA }),
        lowBGroup: root.createBindGroup(srcLayout, { src: lowB }),
        compositeGroup: root.createBindGroup(compositeLayout, { accum, low: lowA }),
      };
    };
    let targets = makeTargets(width, height);

    let phase = 0;

    const write = () => {
      const cssW = canvas.clientWidth || width;
      const cssH = canvas.clientHeight || height;
      const aspect = cssW / cssH;
      const layout = layoutFor(aspect);
      uniforms.write({
        time: phase,
        aspect,
        brightness: params.brightness,
        rays: params.rays,
        dof: params.dof,
        stars: params.stars,
        bloom: params.bloom,
        copyFade: params.copyFade,
        pix: 1 / targets.size[1],
        sheetCount: layout.sheets.length,
        milky: layout.milky,
        sheets: layout.sheets,
      });
    };

    return {
      resize(w, h) {
        for (const t of targets.textures) t.destroy();
        targets = makeTargets(w, h);
      },

      frame(state) {
        phase += state.dt * params.speed;
        write();
        const encoder = root.createCommandEncoder();
        const draw = encoder.beginRenderPass({ colorAttachments: { view: targets.accumView } });
        curtainPipeline.with(draw).draw(3);
        draw.end();

        const low = encoder.beginRenderPass({ colorAttachments: { view: targets.lowAView } });
        lowPipeline.with(targets.accumGroup).with(low).draw(3);
        low.end();
        for (let k = 0; k < blurs.length; k++) {
          const toB = k % 2 === 0;
          const pass = encoder.beginRenderPass({
            colorAttachments: { view: toB ? targets.lowBView : targets.lowAView },
          });
          blurs[k]!.with(toB ? targets.lowAGroup : targets.lowBGroup)
            .with(pass)
            .draw(3);
          pass.end();
        }

        const out = encoder.beginRenderPass({ colorAttachments: { view: context } });
        compositePipeline.with(targets.compositeGroup).with(out).draw(3);
        out.end();
        encoder.submit();
      },

      destroy() {
        for (const t of targets.textures) t.destroy();
        uniforms.buffer.destroy();
        noiseCache.destroy();
      },
    };
  },
});
