// @ts-nocheck -- TypeGPU shader code uses vector operators (`a - b` on vectors), which need the
// tsover compiler the TypeGPU lab builds with; plain TypeScript rejects them. unplugin-typegpu
// compiles these functions to WGSL at build time. Edit in the lab and copy here.
import { d, std } from "typegpu";

/** sRGB (0..1) to linear light. */
export const toLinear = (c: d.v3f) => {
  "use gpu";
  const lo = c / 12.92;
  const hi = std.pow((c + 0.055) / 1.055, d.vec3f(2.4));
  return std.select(hi, lo, std.le(c, d.vec3f(0.04045)));
};

/** Linear light to sRGB (0..1). */
export const toSrgb = (c: d.v3f) => {
  "use gpu";
  const x = std.max(c, d.vec3f());
  const lo = x * 12.92;
  const hi = std.pow(x, d.vec3f(1 / 2.4)) * 1.055 - 0.055;
  return std.select(hi, lo, std.le(x, d.vec3f(0.0031308)));
};

/** Linear sRGB to Oklab. */
export const linearToOklab = (c: d.v3f) => {
  "use gpu";
  const l = 0.4122214708 * c.x + 0.5363325363 * c.y + 0.0514459929 * c.z;
  const m = 0.2119034982 * c.x + 0.6806995451 * c.y + 0.1073969566 * c.z;
  const s = 0.0883024619 * c.x + 0.2817188376 * c.y + 0.6299787005 * c.z;
  const lms = std.pow(std.max(d.vec3f(l, m, s), d.vec3f()), d.vec3f(1 / 3));
  return d.vec3f(
    0.2104542553 * lms.x + 0.793617785 * lms.y - 0.0040720468 * lms.z,
    1.9779984951 * lms.x - 2.428592205 * lms.y + 0.4505937099 * lms.z,
    0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.808675766 * lms.z,
  );
};

/** Oklab to linear sRGB. */
export const oklabToLinear = (c: d.v3f) => {
  "use gpu";
  const l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  const m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  const s = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  const lms = d.vec3f(l, m, s);
  const cube = lms * lms * lms;
  return d.vec3f(
    4.0767416621 * cube.x - 3.3077115913 * cube.y + 0.2309699292 * cube.z,
    -1.2684380046 * cube.x + 2.6097574011 * cube.y - 0.3413193965 * cube.z,
    -0.0041960863 * cube.x - 0.7034186147 * cube.y + 1.707614701 * cube.z,
  );
};

/** sRGB in, sRGB out, interpolated in Oklab so midpoints don't go muddy. */
export const mixOklab = (a: d.v3f, b: d.v3f, t: number) => {
  "use gpu";
  const la = linearToOklab(toLinear(a));
  const lb = linearToOklab(toLinear(b));
  return toSrgb(oklabToLinear(std.mix(la, lb, t)));
};

/**
 * Interleaved gradient noise in [0, 1). Add about +-0.5/255 of it to the final
 * color to break up banding in smooth gradients. Pass pixel coordinates.
 */
export const ditherNoise = (pixel: d.v2f) => {
  "use gpu";
  return std.fract(52.9829189 * std.fract(std.dot(pixel, d.vec2f(0.06711056, 0.00583715))));
};
