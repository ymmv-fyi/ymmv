import { d } from "typegpu";

/**
 * Per-frame values every concept can read. Colors are sRGB in 0..1;
 * convert with the helpers in `color.ts` before blending.
 */
export const Frame = d.struct({
  /** Canvas size in physical pixels. */
  resolution: d.vec2f,
  /** Physical pixels per CSS pixel (DPR times render scale). */
  pixelRatio: d.f32,
  /** Hero copy block in UV space: (minX, minY, maxX, maxY). See `copyMask`. */
  copyRect: d.vec4f,
  time: d.f32,
  dt: d.f32,
  /** Smoothed pointer, UV space (0..1, top-left origin). */
  pointer: d.vec2f,
  /** Pointer velocity in UV units per second. */
  pointerVelocity: d.vec2f,
  /** 0..1, eased. 1 while the pointer is over the hero. */
  pointerActive: d.f32,
  /** 1 while a button is held. */
  pointerDown: d.f32,
  bg: d.vec3f,
  c0: d.vec3f,
  c1: d.vec3f,
  c2: d.vec3f,
});
