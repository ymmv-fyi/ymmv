// @ts-nocheck -- TypeGPU shader code uses vector operators (`a - b` on vectors), which need the
// tsover compiler the TypeGPU lab builds with; plain TypeScript rejects them. unplugin-typegpu
// compiles these functions to WGSL at build time. Edit in the lab and copy here.
import { d, std } from "typegpu";

/**
 * Weight in 0..1 that is 1 over the hero copy block and falls off smoothly
 * around it. Mix toward the background by `copyMask(...) * amount` to keep
 * headlines legible.
 *
 * - `uv`: 0..1, top-left origin.
 * - `rect`: the copy block in the same UV space as (minX, minY, maxX, maxY).
 *   Pass `frame.$.copyRect`; the harness measures it from the DOM every frame,
 *   so it follows the layout at any viewport size.
 * - `aspect`: width / height.
 */
export const copyMask = (uv: d.v2f, rect: d.v4f, aspect: number) => {
  "use gpu";
  const scale = d.vec2f(aspect, 1);
  const center = (rect.xy + rect.zw) * 0.5 * scale;
  const half = (rect.zw - rect.xy) * 0.5 * scale;
  // Rounded-box distance in screen-height units.
  const radius = 0.08;
  const q = std.abs(uv * scale - center) - half + radius;
  const dist = std.length(std.max(q, d.vec2f())) + std.min(std.max(q.x, q.y), 0) - radius;
  return 1 - std.smoothstep(-0.05, 0.3, dist);
};
