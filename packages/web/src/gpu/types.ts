import type { TgpuRoot, TgpuUniform } from "typegpu";
import type { Frame } from "./frame.ts";

export type Rgb = [number, number, number];

export interface Palette {
  name: string;
  /** Page background behind the effect. */
  bg: Rgb;
  /** Three accent colors, roughly ordered from dominant to highlight. */
  colors: [Rgb, Rgb, Rgb];
  /** Text color that reads on top of this palette. */
  ink: "light" | "dark";
}

/** Mock hero text shown over a concept. Defaults to the generic lab copy. */
export interface HeroCopy {
  mark: string;
  links: [string, string, string];
  headline: string;
  body: string;
  primary: string;
  secondary: string;
  /** Fill the primary button with the palette accent instead of the ink color. */
  accentButton?: boolean;
}

export type ParamDef =
  | { type: "number"; label?: string; value: number; min: number; max: number; step?: number }
  | { type: "boolean"; label?: string; value: boolean }
  | { type: "select"; label?: string; value: string; options: Record<string, string> };

export type ParamDefs = Record<string, ParamDef>;

/** The live values for a set of param definitions. Mutated in place by the panel. */
export type ParamValues<P extends ParamDefs> = {
  [K in keyof P]: P[K] extends { type: "number" }
    ? number
    : P[K] extends { type: "boolean" }
      ? boolean
      : string;
};

export interface ConceptContext {
  root: TgpuRoot;
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  /**
   * Shared per-frame uniform (time, resolution, pointer, palette), written by the
   * harness before every `frame()` call. Read it in shaders as `frame.$`.
   */
  frame: TgpuUniform<typeof Frame>;
  /** Current canvas size in physical pixels. */
  width: number;
  height: number;
}

export interface FrameState {
  /** Seconds of animation time. Scaled by the speed control; stops while paused. */
  time: number;
  /** Animation-time delta for this frame (0 while paused), clamped to avoid jumps. */
  dt: number;
  width: number;
  height: number;
  /** Physical pixels per CSS pixel. */
  pixelRatio: number;
  /** Smoothed pointer in canvas UV space (0..1, top-left origin). */
  pointer: { x: number; y: number };
  /** Eases toward 1 while the pointer is over the hero, 0 when it leaves. */
  pointerActive: number;
  pointerDown: boolean;
  /**
   * Total presses (click/tap) on the hero since mount. Compare with the last value
   * you saw to react to clicks; unlike the rising edge of `pointerDown`, this never
   * misses a tap that starts and ends between two frames.
   */
  presses: number;
  /** Exact (unsmoothed) UV of the most recent press. */
  press: { x: number; y: number };
  /** Hero copy block in UV space, (minX, minY, maxX, maxY); same value as `frame.$.copyRect`. */
  copyRect: readonly [number, number, number, number];
}

export interface ConceptInstance {
  /** Called when the canvas size changes. Recreate size-dependent textures here. */
  resize?(width: number, height: number): void;
  /** Encode and submit this frame's GPU work. The frame uniform is already written. */
  frame(state: FrameState): void;
  /** Destroy every buffer and texture this instance created. */
  destroy(): void;
}

export interface Concept<P extends ParamDefs = ParamDefs> {
  id: string;
  name: string;
  /** One line on the look and where it fits. */
  blurb: string;
  /** Lower sorts first in the lab list. */
  order?: number;
  /** Name of the palette this concept looks best with; applied when it's opened. */
  palette?: string;
  /** Groups concepts in the lab list, e.g. by client. Ungrouped concepts come first. */
  group?: string;
  /** Mock hero copy for this concept, e.g. a client's real headline. */
  copy?: HeroCopy;
  params: P;
  create(ctx: ConceptContext, params: ParamValues<P>): ConceptInstance;
}

/** Identity helper that keeps the param types inferred. */
export function defineConcept<P extends ParamDefs>(concept: Concept<P>): Concept<P> {
  return concept;
}
