/// <reference types="@webgpu/types" />
// The landing's hero: the TypeGPU lab's Borealis concept behind the hero copy (DESIGN.md → Landing).
// index.astro imports this only when the browser has WebGPU; everywhere else the hero keeps its CSS
// glow, and the page is the same.
import borealis from "./borealis.ts";
import { Harness } from "./harness.ts";
import type { Palette, ParamValues } from "./types.ts";

const hex = (v: string): [number, number, number] => {
  const n = Number.parseInt(v.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** The page --bg under the curtains (so the canvas meets the page with no seam), deep → body → core. */
const palette: Palette = {
  name: "aurora",
  bg: hex("#050607"),
  colors: [hex("#0e4f6b"), hex("#22d3a0"), hex("#d6ffef")],
  ink: "light",
};

/**
 * Start the aurora in `canvas`, keeping it dim behind `copy` (measured every frame).
 * Reduced motion holds a still frame; off-screen or in a hidden tab, nothing renders.
 */
export async function startAuroraHero(canvas: HTMLCanvasElement, copy: HTMLElement): Promise<void> {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const settings = { speed: 1, paused: reduced.matches, idle: false, renderScale: 1 };
  let onScreen = true;
  const update = () => {
    settings.paused = reduced.matches;
    settings.idle = !onScreen || document.hidden;
  };
  reduced.addEventListener("change", update);
  document.addEventListener("visibilitychange", update);
  new IntersectionObserver(([entry]) => {
    onScreen = entry?.isIntersecting ?? true;
    update();
  }).observe(canvas);

  const harness = await Harness.create(canvas, settings, () => palette, copy);
  // A GPU failure mid-run takes the canvas away, leaving the CSS glow behind it.
  harness.onError = () => canvas.remove();
  const params = Object.fromEntries(
    Object.entries(borealis.params).map(([key, def]) => [key, def.value]),
  ) as ParamValues<typeof borealis.params>;
  params.brightness = 0.95;
  params.copyFade = 0.9;
  harness.mount(borealis, params);
}
