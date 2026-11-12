// The landing's aurora: curtains of rays seen from below on a fast lens, a bloom pass, and the
// composite with stars, grain and the page background. Generated once from the TypeGPU original
// (TypeGPU 0.12 + @typegpu/noise) and kept as plain WGSL, so the page ships no shader compiler.
//
// Passes, in order (aurora.ts): fill (once) -> curtainFragment -> lowFragment -> blur x4 ->
// compositeFragment. All render passes draw one full-screen triangle.

// ---- shared ----

struct fullScreenTriangle_Output {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn fullScreenTriangle(@builtin(vertex_index) vertexIndex: u32) -> fullScreenTriangle_Output {
  const pos = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  const uv = array<vec2f, 3>(vec2f(0, 1), vec2f(2, 1), vec2f(0, -1));

  return fullScreenTriangle_Output(vec4f(pos[vertexIndex], 0, 1), uv[vertexIndex]);
}

struct Sheet {
  geo: vec4f,
  edge: vec4f,
  shape: vec4f,
  motion: vec4f,
  look: vec4f,
  extra: vec4f,
}

struct Uniforms {
  time: f32,
  aspect: f32,
  brightness: f32,
  rays: f32,
  dof: f32,
  stars: f32,
  bloom: f32,
  copyFade: f32,
  pix: f32,
  sheetCount: u32,
  milky: vec4f,
  sheets: array<Sheet, 5>,
}

struct Frame {
  resolution: vec2f,
  pixelRatio: f32,
  copyRect: vec4f,
  time: f32,
  dt: f32,
  pointer: vec2f,
  pointerVelocity: vec2f,
  pointerActive: f32,
  pointerDown: f32,
  bg: vec3f,
  c0: vec3f,
  c1: vec3f,
  c2: vec3f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<uniform> frame: Frame;
@group(0) @binding(2) var sampler_1: sampler;
/** Perlin gradients, one per cell of a 32^3 cube; written once by `fill`. */
@group(0) @binding(3) var<storage, read> memory: array<vec3f, 32768>;
@group(0) @binding(4) var<storage, read_write> memoryOut: array<vec3f, 32768>;
/** The pass's input: the HDR target for lowFragment, the bloom chain for blur, accum for the composite. */
@group(1) @binding(0) var src: texture_2d<f32>;
/** The composite's second input: the blurred bloom target. */
@group(1) @binding(1) var srcLow: texture_2d<f32>;

fn hashU(v: u32) -> u32 {
  let s = ((v * 747796405u) + 2891336453u);
  let w = (((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u);
  return ((w >> 22u) ^ w);
}

fn unit(h: u32) -> f32 {
  return (f32((h >> 8u)) / 16777216f);
}

fn copyMask(uv: vec2f, rect: vec4f, aspect: f32) -> f32 {
  let scale = vec2f(aspect, 1f);
  let center = (((rect.xy + rect.zw) * 0.5f) * scale);
  let half = (((rect.zw - rect.xy) * 0.5f) * scale);
  const radius = 0.08;
  let q = ((abs(((uv * scale) - center)) - half) + radius);
  let dist = ((length(max(q, vec2f())) + min(max(q.x, q.y), 0f)) - radius);
  return (1f - smoothstep(-0.05f, 0.3f, dist));
}

fn toLinear(c: vec3f) -> vec3f {
  let lo = (c / 12.92f);
  let hi = pow(((c + 0.055f) / 1.055f), vec3f(2.4000000953674316));
  return select(hi, lo, (c <= vec3f(0.040449999272823334)));
}

fn linearToOklab(c: vec3f) -> vec3f {
  let l = (((0.4122214708f * c.x) + (0.5363325363f * c.y)) + (0.0514459929f * c.z));
  let m = (((0.2119034982f * c.x) + (0.6806995451f * c.y)) + (0.1073969566f * c.z));
  let s = (((0.0883024619f * c.x) + (0.2817188376f * c.y)) + (0.6299787005f * c.z));
  let lms = pow(max(vec3f(l, m, s), vec3f()), vec3f(0.3333333432674408));
  return vec3f((((0.2104542553f * lms.x) + (0.793617785f * lms.y)) - (0.0040720468f * lms.z)), (((1.9779984951f * lms.x) - (2.428592205f * lms.y)) + (0.4505937099f * lms.z)), (((0.0259040371f * lms.x) + (0.7827717662f * lms.y)) - (0.808675766f * lms.z)));
}

fn oklabToLinear(c: vec3f) -> vec3f {
  let l = ((c.x + (0.3963377774f * c.y)) + (0.2158037573f * c.z));
  let m = ((c.x - (0.1055613458f * c.y)) - (0.0638541728f * c.z));
  let s = ((c.x - (0.0894841775f * c.y)) - (1.291485548f * c.z));
  let lms = vec3f(l, m, s);
  let cube = ((lms * lms) * lms);
  return vec3f((((4.0767416621f * cube.x) - (3.3077115913f * cube.y)) + (0.2309699292f * cube.z)), (((-1.2684380046f * cube.x) + (2.6097574011f * cube.y)) - (0.3413193965f * cube.z)), (((-0.0041960863f * cube.x) - (0.7034186147f * cube.y)) + (1.707614701f * cube.z)));
}

// ---- random (seeded per call site) ----

fn hash(value: u32) -> u32 {
  {
    var x = (value ^ (value >> 17u));
    x *= 3982152891u;
    x ^= (x >> 11u);
    x *= 2890668881u;
    x ^= (x >> 15u);
    x *= 830770091u;
    x ^= (x >> 14u);
    return x;
  }
}

fn scrambleSeed3(value: vec3f) -> vec3u {
  let u32Value = bitcast<vec3u>(value);
  return vec3u(hash((u32Value.x ^ 1253408251u)), hash((u32Value.y ^ 2900286023u)), hash((u32Value.z ^ 3164612939u)));
}

fn rotl(x: u32, k: u32) -> u32 {
  return ((x << k) | (x >> (32u - k)));
}

var<private> gpuSeed: vec2u;

fn seed3(value: vec3f) {
  let scrambled = scrambleSeed3(value);
  let newSeed = vec2u(hash((scrambled.x ^ rotl(scrambled.z, 16u))), hash((rotl(scrambled.y, 16u) ^ scrambled.z)));
  gpuSeed = newSeed;
}

fn randSeed3(seed: vec3f) {
  seed3(seed);
}

fn next() -> u32 {
  {
    let s0 = gpuSeed.x;
    var s1 = gpuSeed.y;
    s1 ^= s0;
    gpuSeed.x = ((rotl(s0, 26u) ^ s1) ^ (s1 << 9u));
    gpuSeed.y = rotl(s1, 13u);
    return (rotl((gpuSeed.x * 2654435771u), 5u) * 5u);
  }
}

fn u32To01F32(value: u32) -> f32 {
  let mantissa = (value & 8388607u);
  let bits = (1065353216u | mantissa);
  let f = bitcast<f32>(bits);
  return (f - 1f);
}

fn randSample() -> f32 {
  let r = next();
  return u32To01F32(r);
}

fn randFloat01() -> f32 {
  return randSample();
}

fn randOnUnitSphere() -> vec3f {
  let z = ((2f * randSample()) - 1f);
  let oneMinusZSq = sqrt((1f - (z * z)));
  let theta = (6.283185307179586f * randSample());
  let x = (cos(theta) * oneMinusZSq);
  let y = (sin(theta) * oneMinusZSq);
  return vec3f(x, y, z);
}

fn computeJunctionGradient(pos: vec3i) -> vec3f {
  randSeed3((1e-3f * vec3f(pos)));
  return randOnUnitSphere();
}

// ---- gradient fill: dispatched once, 4x4x8 workgroups cover the 32^3 cube exactly ----
@compute @workgroup_size(8, 8, 4) fn fill(@builtin(global_invocation_id) id: vec3u) {
  memoryOut[((id.x + (id.y * 32u)) + ((id.z * 32u) * 32u))] = computeJunctionGradient(vec3i(i32(id.x), i32(id.y), i32(id.z)));
}

// ---- perlin noise ----

fn getJunctionGradient(pos: vec3i) -> vec3f {
  let x = (pos.x & 31i);
  let y = (pos.y & 31i);
  let z = (pos.z & 31i);
  return memory[((x + (y * 32i)) + ((z * 32i) * 32i))];
}

fn dotProdGrid(pos: vec3f, junction: vec3f) -> f32 {
  let relative = (pos - junction);
  let gridVector = getJunctionGradient(vec3i(junction));
  return dot(relative, gridVector);
}

fn quinticInterpolation(t: vec3f) -> vec3f {
  return (((t * t) * t) * ((t * ((t * 6f) - 15f)) + 10f));
}

fn perlin(pos: vec3f) -> f32 {
  let minJunction = floor(pos);
  let xyz = dotProdGrid(pos, minJunction);
  let xyZ = dotProdGrid(pos, (minJunction + vec3f(0, 0, 1)));
  let xYz = dotProdGrid(pos, (minJunction + vec3f(0, 1, 0)));
  let xYZ = dotProdGrid(pos, (minJunction + vec3f(0, 1, 1)));
  let Xyz = dotProdGrid(pos, (minJunction + vec3f(1, 0, 0)));
  let XyZ = dotProdGrid(pos, (minJunction + vec3f(1, 0, 1)));
  let XYz = dotProdGrid(pos, (minJunction + vec3f(1, 1, 0)));
  let XYZ = dotProdGrid(pos, (minJunction + vec3f(1)));
  let partial = (pos - minJunction);
  let smoothPartial = quinticInterpolation(partial);
  let xy = mix(xyz, xyZ, smoothPartial.z);
  let xY = mix(xYz, xYZ, smoothPartial.z);
  let Xy = mix(Xyz, XyZ, smoothPartial.z);
  let XY = mix(XYz, XYZ, smoothPartial.z);
  let x = mix(xy, xY, smoothPartial.y);
  let X = mix(Xy, XY, smoothPartial.y);
  return mix(x, X, smoothPartial.x);
}

// ---- curtains (HDR target) ----

fn rayOctave(x: f32, foot: f32, width: f32, seed: u32, h: f32, t: f32, jag: f32, vblur: f32) -> f32 {
  let base = floor(x);
  let hp = max(h, 0f);
  var sum = 0f;
  for (var j = -1; (j <= 1i); j++) {
    let i = (base + f32(j));
    let h1 = hashU((u32((i + 65536f)) ^ seed));
    let h2 = hashU(h1);
    let h3 = hashU(h2);
    let h4 = hashU(h3);
    let r1 = unit(h1);
    let r2 = unit(h2);
    let r3 = unit(h3);
    let r4 = unit(h4);
    let fw = (3f + (7f * r1));
    let wob = (((0.27f * min((0.12f + hp), 1f)) * sin((((h * fw) + (t * (0.08f + (0.2f * r3)))) + (r2 * 31f)))) * exp(((((-2f * fw) * fw) * vblur) * vblur)));
    let c = (((i + 0.5f) + ((r1 - 0.5f) * 0.7f)) + wob);
    let w = (width * (0.18f + (((1.9f * r2) * r2) * r2)));
    let we = sqrt(((w * w) + (foot * foot)));
    let fa = (2f + (7f * r3));
    let fb = (9f + (14f * r1));
    let wa = (sin((((h * fa) + (t * (0.12f + (0.4f * r2)))) + (r1 * 40f))) * exp(((((-2f * fa) * fa) * vblur) * vblur)));
    let wb = (sin((((h * fb) - (t * (0.2f + (0.3f * r3)))) + (r2 * 23f))) * exp(((((-2f * fb) * fb) * vblur) * vblur)));
    let keepAlong = (1f - (0.65f * smoothstep(4e-3f, 0.02f, vblur)));
    let along = saturate((0.5f + (keepAlong * ((0.65f * wa) + (0.35f * wb)))));
    let low = (0.5f + (0.9f * exp((-(hp) / 0.25f))));
    let fd = (22f + (30f * r2));
    let dash = smoothstep(-0.4f, 0.9f, sin((((h * fd) + (r1 * 17f)) + (t * (0.3f + (0.4f * r3))))));
    let near = ((exp((-(hp) / 0.08f)) * 0.75f) * exp(((((-2f * fd) * fd) * vblur) * vblur)));
    let seg = mix(1f, (dash * 1.5f), near);
    let end = smoothstep((-0.01f - vblur), (0.025f + vblur), (h - ((r2 - 0.35f) * jag)));
    let present = step(0.2f, r4);
    let amp = ((((((((0.3f + ((1.5f * r3) * r3)) * present) * along) * low) * seg) * end) * (w / we)) / (0.6f + ((0.4f * w) / width)));
    let dx = (x - c);
    let core = exp(((dx * dx) / ((-2f * we) * we)));
    let halo = exp(((dx * dx) / ((-9.7f * we) * we)));
    sum += (amp * (core + (0.1f * halo)));
  }
  let mean = (((0.17820000000000003f * width) * 2.5066f) * 1.22f);
  return mix((sum / mean), 1f, smoothstep(0.22f, 0.55f, foot));
}

fn sheetLight(p: vec2f, idx: u32, pix: f32) -> f32 {
  let u = (&uniforms);
  let sh = (&(*u).sheets[idx]);
  let t = (*u).time;
  let dy = (p.y - (*sh).geo.y);
  if (((dy < 0.05f) || ((*sh).shape.y < 1e-4f))) {
    return 0f;
  }
  let fl = max((dy - 1.1f), 0f);
  let flare = (1f + (((*sh).extra.y * fl) * fl));
  let s = (((p.x - (*sh).geo.x) / dy) / flare);
  let seed = (*sh).shape.w;
  let sway = ((*sh).motion.z * (sin(((((s * 7f) + (dy * 1.6f)) - (t * 0.21f)) + seed)) + (0.6f * sin(((((s * 19f) - (dy * 2.9f)) + (t * 0.17f)) + (seed * 1.7f))))));
  let span = ((*sh).geo.w - (*sh).geo.z);
  let u0 = (((s + sway) - (*sh).geo.z) / span);
  let ff = ((*sh).motion.y * 6.2831853f);
  let ph = (((u0 * ff) - ((t * (*sh).motion.w) * 6.2831853f)) + (seed * 3.1f));
  let ph2 = ((((u0 * ff) * 2.3f) + ((t * (*sh).motion.w) * 4.1f)) + (seed * 1.3f));
  let fa = (*sh).motion.x;
  let uf = ((u0 + ((fa * sin(ph)) / ff)) + (((fa * 0.25f) * sin(ph2)) / (ff * 2.3f)));
  let dens = max(((1f + (fa * cos(ph))) + ((fa * 0.25f) * cos(ph2))), 0.05f);
  let stretch = ((((sqrt((1f + (s * s))) / dy) / flare) / span) * dens);
  let coc = (((*sh).shape.z + (((*sh).extra.z * (1f - p.y)) * (1f - p.y))) * (*u).dof);
  let pixU = (pix * stretch);
  let cocU = (coc * stretch);
  let ye = ((((*sh).edge.x + ((*sh).edge.y * (uf - 0.5f))) + (((*sh).edge.z * (uf - 0.5f)) * (uf - 0.5f))) + ((min(((*sh).shape.x * 0.3f), 0.03f) * (0.35f + (0.65f * smoothstep(0.5f, 1.3f, (*u).aspect)))) * (sin((((uf * 7.3f) - (t * 0.21f)) + seed)) + (0.4f * sin((((uf * 17.1f) + (t * 0.37f)) + (seed * 2f)))))));
  let h = (ye - p.y);
  let soft = (((*sh).edge.w + coc) + pix);
  let below = (min(h, 0f) / ((*sh).extra.x + soft));
  let rise = max(smoothstep(-(soft), (soft * 0.5f), h), (0.74f * exp((below * (1f - (0.5f * below))))));
  let hp = max(h, 0f);
  let L = (*sh).shape.x;
  let vert = ((rise * exp((-(hp) / L))) * (0.8f + (0.2f * exp((-(hp) / ((L * 0.12f) + soft))))));
  let sf = ((*sh).look.w + cocU);
  let sr = (((*sh).extra.w + cocU) + pixU);
  let body = (smoothstep(0f, sf, uf) * smoothstep(1f, (1f - sr), uf));
  let hair = ((smoothstep(-0.3f, 0.02f, uf) * smoothstep((1f + sr), (1f - sr), uf)) * (1f - smoothstep(3e-3f, 0.012f, coc)));
  let env = (((((*sh).shape.y * (*u).brightness) * pow(dens, 1.4f)) * vert) * max(body, (hair * 0.3f)));
  if ((((env * exp(((*sh).look.z * 0.7f))) * 6f) < 4e-4f)) {
    return 0f;
  }
  let iseed = u32((seed * 1000f));
  var rays = 0f;
  var coarse = 1f;
  for (var k = 0; (k < 3i); k++) {
    let fk = f32(k);
    let n = ((*sh).look.x * pow(2.55f, fk));
    let foot = (n * sqrt((((pixU * pixU) * 0.2f) + (cocU * cocU))));
    var r = 1f;
    if ((foot < 0.55f)) {
      let xn = (uf * n);
      let xw = ((xn + (0.9f * sin((((xn * 0.31f) + (seed * 5f)) + fk)))) + (0.55f * sin((((xn * 0.83f) + (seed * 2.3f)) - fk))));
      r = rayOctave(xw, foot, (0.085f - (0.01f * fk)), (iseed + (u32(k) * 7919u)), h, t, ((0.06f * (1f - (fk * 0.4f))) * (1f - smoothstep(3e-3f, 0.015f, coc))), coc);
    }
    if ((k == 0i)) {
      coarse = r;
    }
    rays += (r * pow(0.2f, fk));
  }
  rays = (rays / 1.24f);
  let contrast = ((*sh).look.y * (*u).rays);
  let R = max(mix(1f, rays, contrast), 0f);
  let hairR = max(mix(1f, coarse, min(contrast, 1f)), 0f);
  let n1 = perlin(vec3f((((uf * 2.6f) - (t * 0.035f)) + (seed * 7.1f)), ((h * 1.1f) + seed), (t * 0.05f)));
  let n2 = perlin(vec3f((((uf * 7.5f) + (seed * 3.3f)) - (t * 0.06f)), (h * 2.6f), ((t * 0.08f) + 4.1f)));
  let sharp = exp((-(cocU) * 10f));
  let pn = ((n1 * 0.9f) + ((n2 * 0.45f) * sharp));
  let mid = (smoothstep(0.02f, 0.14f, h) * exp((-(hp) / 0.7f)));
  let hot = (smoothstep(0.1f, 0.55f, pn) * mid);
  let patch_1 = (exp((((*sh).look.z * 0.75f) * pn)) * (1f + (((3.6f * hot) * min(((*sh).look.z / 3f), 1f)) * (1f - smoothstep(4e-3f, 0.012f, coc)))));
  let n4 = perlin(vec3f((((uf * (*sh).look.x) * 0.35f) + (seed * 1.9f)), ((h * 2.4f) - (t * 0.03f)), ((t * 0.07f) + 2.2f)));
  let streak = exp((((1.3f * n4) * min((*u).rays, 1.5f)) * sharp));
  var wisp = 1f;
  if ((sharp > 0.05f)) {
    let n3 = perlin(vec3f(((uf * 21f) + seed), ((h * 1.7f) - (t * 0.04f)), ((t * 0.06f) + 9.3f)));
    wisp = max((1f + (((n3 * 1.3f) * sharp) * min((*u).rays, 1.5f))), 0.1f);
  }
  let shape = ((body * (((0.07f * wisp) * sqrt(patch_1)) + (((0.93f * R) * streak) * patch_1))) + ((((max((hair - body), 0f) * hairR) * streak) * patch_1) * 0.3f));
  return ((env / max(body, (hair * 0.3f))) * shape);
}

fn ramp(heat: f32) -> vec3f {
  let f = (&frame);
  let c0 = linearToOklab(toLinear((*f).c0));
  let c1 = linearToOklab(toLinear((*f).c1));
  let c2 = linearToOklab(toLinear((*f).c2));
  var lab = mix(c0, c1, smoothstep(0f, 0.5f, heat));
  lab = mix(lab, c2, smoothstep(0.5f, 1f, heat));
  let rgb = max(oklabToLinear(lab), vec3f());
  return (rgb / max(max(rgb.x, max(rgb.y, rgb.z)), 1e-4f));
}

struct curtainFragment_Input {
  @location(0) uv: vec2f,
}

@fragment fn curtainFragment(_arg_0: curtainFragment_Input) -> @location(0) vec4f {
  let u = (&uniforms);
  let f = (&frame);
  let p = (_arg_0.uv * vec2f((*u).aspect, 1f));
  let pix = (*u).pix;
  var total = 0f;
  for (var i = 0u; (i < (*u).sheetCount); i++) {
    total += sheetLight(p, i, pix);
  }
  let mask = smoothstep(0.3f, 0.95f, copyMask(_arg_0.uv, (*f).copyRect, (*u).aspect));
  total = (total * (1f - (mask * (*u).copyFade)));
  let heat = saturate(((log2(max(total, 1e-6f)) + 6.6f) / 6.6f));
  return vec4f((ramp(heat) * total), total);
}

// ---- bloom source + Milky Way (quarter-size target) ----

fn brightPass(c: vec3f) -> vec3f {
  let m = max(c.x, max(c.y, c.z));
  return ((c * (max((m - 0.5f), 0f) / max(m, 1e-4f))) + (c * 0.04f));
}

struct lowFragment_Input {
  @location(0) uv: vec2f,
}

@fragment fn lowFragment(_arg_0: lowFragment_Input) -> @location(0) vec4f {
  let u = (&uniforms);
  let f = (&frame);
  let uv = _arg_0.uv;
  let texel = (1f / vec2f(textureDimensions(src)));
  let t0 = textureSample(src, sampler_1, (uv + (texel * vec2f(-1)))).xyz;
  let t1 = textureSample(src, sampler_1, (uv + (texel * vec2f(1, -1)))).xyz;
  let t2 = textureSample(src, sampler_1, (uv + (texel * vec2f(-1, 1)))).xyz;
  let t3 = textureSample(src, sampler_1, (uv + (texel * vec2f(1)))).xyz;
  let bright = ((((brightPass(t0) + brightPass(t1)) + brightPass(t2)) + brightPass(t3)) * (0.25f * (*u).bloom));
  let s = vec2f((*u).aspect, 1f);
  let a = ((*u).milky.xy * s);
  let ab = (((*u).milky.zw * s) - a);
  let q = (uv * s);
  let tt = saturate((dot((q - a), ab) / dot(ab, ab)));
  let dist = length((q - (a + (ab * tt))));
  let m1 = perlin(vec3f((q * 3.1f), 1.7f));
  let m2 = perlin(vec3f(((q * 9.3f) + 4.1f), 2.9f));
  let band = (exp((-((dist * dist)) / 0.012f)) * saturate(((0.55f + (0.8f * m1)) + (0.4f * m2))));
  let keep = (1f - ((copyMask(uv, (*f).copyRect, (*u).aspect) * (*u).copyFade) * 0.6f));
  let milky = (mix(toLinear((*f).c0), vec3f(0.5, 0.550000011920929, 0.5), 0.5f) * (((band * 6e-3f) * (*u).stars) * keep));
  return vec4f((bright + milky), 1f);
}

// ---- separable 9-tap Gaussian; the pipeline sets the tap direction and spacing ----
override blurX: f32;
override blurY: f32;

struct blur_Input {
  @location(0) uv: vec2f,
}

@fragment fn blur(_arg_0: blur_Input) -> @location(0) vec4f {
  let texel = (1f / vec2f(textureDimensions(src)));
  let step_1 = (vec2f(blurX, blurY) * texel);
  let a = (textureSample(src, sampler_1, _arg_0.uv) * 0.227027f);
  let b = (textureSample(src, sampler_1, (_arg_0.uv + (step_1 * 1.384615f))) * 0.316216f);
  let c = (textureSample(src, sampler_1, (_arg_0.uv - (step_1 * 1.384615f))) * 0.316216f);
  let e = (textureSample(src, sampler_1, (_arg_0.uv + (step_1 * 3.230769f))) * 0.07027f);
  let g = (textureSample(src, sampler_1, (_arg_0.uv - (step_1 * 3.230769f))) * 0.07027f);
  return ((((a + b) + c) + e) + g);
}

// ---- composite (canvas) ----

fn starField(px: vec2f, pr: f32) -> vec3f {
  let cell = (11f * pr);
  let q = (px / cell);
  let id = floor(q);
  let h1 = hashU(((u32((id.x + 4096f)) * 73856093u) + (u32((id.y + 4096f)) * 19349663u)));
  let h2 = hashU(h1);
  let h3 = hashU(h2);
  let h4 = hashU(h3);
  var col = vec3f();
  if ((unit(h1) < 0.14f)) {
    let pos = ((id + 0.2f) + (vec2f(unit(h2), unit(h3)) * 0.6f));
    let dd = ((q - pos) * cell);
    let mag = pow(unit(h4), 7f);
    let r = ((0.5f + (0.45f * mag)) * pr);
    let v = (exp((-(dot(dd, dd)) / ((2f * r) * r))) * (5e-3f + (0.35f * mag)));
    let tint = unit(hashU(h4));
    var c = vec3f(1, 0.9700000286102295, 0.9200000166893005);
    if ((tint < 0.1f)) {
      c = vec3f(1, 0.7200000286102295, 0.5);
    }
    if ((tint > 0.95f)) {
      c = vec3f(0.699999988079071, 0.8199999928474426, 1);
    }
    col = (c * v);
  }
  return col;
}

fn shoulder(c: vec3f, knee: f32) -> vec3f {
  let k = vec3f(knee);
  let room = (1f - knee);
  let over = max((c - k), vec3f());
  let compressed = (k + ((1f - exp((over * (-1f / room)))) * room));
  return select(compressed, c, (c <= k));
}

fn tonemap(c: vec3f, knee: f32) -> vec3f {
  let m = max(c.x, max(c.y, c.z));
  let mm = shoulder(vec3f(m), knee).x;
  let kept = (c * (mm / max(m, 1e-5f)));
  return mix(kept, shoulder(c, knee), 0.2f);
}

fn toSrgb(c: vec3f) -> vec3f {
  let x = max(c, vec3f());
  let lo = (x * 12.92f);
  let hi = ((pow(x, vec3f(0.4166666567325592)) * 1.055f) - 0.055f);
  return select(hi, lo, (x <= vec3f(0.0031308000907301903)));
}

fn ditherNoise(pixel: vec2f) -> f32 {
  return fract((52.9829189f * fract(dot(pixel, vec2f(0.0671105608344078, 0.005837149918079376)))));
}

struct compositeFragment_Input {
  @location(0) uv: vec2f,
}

@fragment fn compositeFragment(_arg_0: compositeFragment_Input, @builtin(position) pos: vec4f) -> @location(0) vec4f {
  let f = (&frame);
  let u = (&uniforms);
  let uv = _arg_0.uv;
  let acc = textureSample(src, sampler_1, uv);
  let low_1 = textureSample(srcLow, sampler_1, uv).xyz;
  let bg = toLinear((*f).bg);
  let lum = dot(bg, vec3f(0.2125999927520752, 0.7152000069618225, 0.0722000002861023));
  let light = smoothstep(0.15f, 0.5f, lum);
  let mask = copyMask(uv, (*f).copyRect, (*u).aspect);
  let curtainLum = max(acc.w, 0f);
  let behind = (0.1f + (0.9f * exp((-(curtainLum) * 40f))));
  let stars = (starField(pos.xy, (*f).pixelRatio) * (((*u).stars * behind) * (1f - ((mask * (*u).copyFade) * 0.5f))));
  let vq = (((uv - 0.5f) * vec2f(1, 0.8999999761581421)) * 2f);
  let vig = (1f - (0.25f * smoothstep(0.35f, 1.5f, length(vq))));
  randSeed3(vec3f(pos.xy, (fract(((*f).time * 7.3f)) * 100f)));
  let grain = ((randFloat01() + randFloat01()) - 1f);
  let emitted = (((acc.xyz + low_1) + stars) * vig);
  let glowLum = dot(emitted, vec3f(0.2125999927520752, 0.7152000069618225, 0.0722000002861023));
  var dark = ((bg + (emitted * (1f + (grain * (0.08f + (0.14f * sqrt(min(glowLum, 1f)))))))) + (grain * 0.0016f));
  let knee = max(0.6f, (max(bg.x, max(bg.y, bg.z)) + 0.02f));
  dark = tonemap(max(dark, vec3f()), min(knee, 0.97f));
  let c0 = toLinear((*f).c0);
  let c1 = toLinear((*f).c1);
  let inkLab = mix(linearToOklab(c0), linearToOklab(c1), 0.45f);
  let ink = max(oklabToLinear(vec3f((inkLab.x * 0.9f), inkLab.yz)), vec3f());
  let amt = (acc.w + (max(low_1.x, max(low_1.y, low_1.z)) * 0.5f));
  let cover = ((1f - exp((amt * -2.6f))) * 0.62f);
  let day = (mix(bg, ink, (cover * vig)) + (grain * 6e-3f));
  var out = toSrgb(mix(dark, day, light));
  out = (out + ((ditherNoise(pos.xy) - 0.5f) / 255f));
  return vec4f(out, 1f);
}
