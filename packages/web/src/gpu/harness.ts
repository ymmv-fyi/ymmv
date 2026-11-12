/// <reference types="@webgpu/types" />
// The render loop behind the landing's hero, from the TypeGPU lab (src/lab/harness.ts), trimmed for
// production: no stats, and no GPU work at all while the hero is off-screen or the tab is hidden.
import { type TgpuRoot, type TgpuUniform, tgpu } from "typegpu";
import { Frame } from "./frame.ts";
import type { Concept, ConceptInstance, Palette, ParamDefs, ParamValues } from "./types.ts";

export interface HarnessSettings {
  speed: number;
  /** Time stands still (reduced motion): frames still render, so the pointer and resizes apply. */
  paused: boolean;
  /** Nothing renders: the hero is off-screen or the tab is hidden. */
  idle: boolean;
  /** Multiplier on device pixels. 1 = native (capped at 2x DPR). */
  renderScale: number;
}

const MAX_DPR = 2;
const MAX_DT = 1 / 20;

export class Harness {
  readonly root: TgpuRoot;
  readonly canvas: HTMLCanvasElement;
  readonly context: GPUCanvasContext;
  readonly format: GPUTextureFormat;
  readonly frame: TgpuUniform<typeof Frame>;

  onError: ((message: string) => void) | null = null;

  private instance: ConceptInstance | null = null;
  private failed = false;
  private width = 0;
  private height = 0;
  private time = 0;
  private lastNow = 0;

  private pointerTarget = { x: 0.5, y: 0.5 };
  private pointer = { x: 0.5, y: 0.5 };
  private pointerVelocity = { x: 0, y: 0 };
  private pointerInside = false;
  private pointerActive = 0;
  private pointerDown = false;
  private presses = 0;
  private press = { x: 0.5, y: 0.5 };

  private copyRect: [number, number, number, number] = [0, 0, 0, 0];
  /** what the held still frame was drawn at, so reduced motion redraws only when that changes */
  private stillKey = "";
  private readonly resizeObserver: ResizeObserver;

  private constructor(
    root: TgpuRoot,
    canvas: HTMLCanvasElement,
    private readonly settings: HarnessSettings,
    private readonly getPalette: () => Palette,
    /** The hero copy block; its rect feeds `copyMask`. */
    private readonly copyElement: HTMLElement | null,
  ) {
    this.root = root;
    this.canvas = canvas;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context = root.configureContext({
      canvas,
      format: this.format,
      alphaMode: "premultiplied",
    });
    this.frame = root.createUniform(Frame);

    root.device.addEventListener("uncapturederror", (event) => {
      this.fail(event.error.message);
    });
    void root.device.lost.then((info) => {
      if (info.reason !== "destroyed") this.fail(`GPU device lost: ${info.message}`);
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);

    window.addEventListener("pointermove", this.handlePointer);
    window.addEventListener("pointerdown", this.handlePointerDown);
    window.addEventListener("pointerup", this.handlePointerUp);

    this.resize();
    requestAnimationFrame(this.loop);
  }

  static async create(
    canvas: HTMLCanvasElement,
    settings: HarnessSettings,
    getPalette: () => Palette,
    copyElement: HTMLElement | null = null,
  ): Promise<Harness> {
    if (!navigator.gpu) throw new Error("This browser does not support WebGPU.");
    // No powerPreference: hero backgrounds should run on the battery-friendly GPU,
    // and Chrome on Windows ignores the hint with a console warning anyway.
    const root = await tgpu.init();
    return new Harness(root, canvas, settings, getPalette, copyElement);
  }

  mount<P extends ParamDefs>(concept: Concept<P>, params: ParamValues<P>): void {
    this.unmount();
    this.failed = false;
    this.time = 0;
    this.presses = 0;
    this.resize();
    // Concepts may simulate inside create(), so the frame uniform must be current.
    this.writeFrame(0);
    try {
      this.instance = concept.create(
        {
          root: this.root,
          canvas: this.canvas,
          context: this.context,
          format: this.format,
          frame: this.frame,
          width: this.width,
          height: this.height,
        },
        params,
      );
    } catch (error) {
      this.fail(describe(error));
    }
  }

  unmount(): void {
    this.instance?.destroy();
    this.instance = null;
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    console.error(message);
    this.onError?.(message);
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR) * this.settings.renderScale;
    const maxSize = this.root.device.limits.maxTextureDimension2D;
    const width = Math.max(1, Math.min(maxSize, Math.round(this.canvas.clientWidth * dpr)));
    const height = Math.max(1, Math.min(maxSize, Math.round(this.canvas.clientHeight * dpr)));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.instance?.resize?.(width, height);
  }

  private get pixelRatio(): number {
    return this.width / Math.max(this.canvas.clientWidth, 1);
  }

  private readonly range = document.createRange();

  /**
   * Bounds of the copy's actual text and buttons, not its container: block
   * elements stretch to their max-width even when the text stops short.
   */
  private measureCopy(): void {
    if (!this.copyElement) return;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const child of this.copyElement.children) {
      this.range.selectNodeContents(child);
      const r = this.range.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (!Number.isFinite(left)) return;
    const canvas = this.canvas.getBoundingClientRect();
    this.copyRect = [
      (left - canvas.left) / canvas.width,
      (top - canvas.top) / canvas.height,
      (right - canvas.left) / canvas.width,
      (bottom - canvas.top) / canvas.height,
    ];
  }

  private writeFrame(dt: number): void {
    this.measureCopy();
    const palette = this.getPalette();
    this.frame.write({
      resolution: [this.width, this.height],
      pixelRatio: this.pixelRatio,
      copyRect: this.copyRect,
      time: this.time,
      dt,
      pointer: [this.pointer.x, this.pointer.y],
      pointerVelocity: [this.pointerVelocity.x, this.pointerVelocity.y],
      pointerActive: this.pointerActive,
      pointerDown: this.pointerDown ? 1 : 0,
      bg: palette.bg,
      c0: palette.colors[0],
      c1: palette.colors[1],
      c2: palette.colors[2],
    });
  }

  private handlePointer = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    this.pointerInside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
    if (this.pointerInside) this.pointerTarget = { x, y };
  };

  private handlePointerDown = (event: PointerEvent): void => {
    this.handlePointer(event);
    if (!this.pointerInside) return;
    this.pointerDown = true;
    this.presses += 1;
    this.press = { ...this.pointerTarget };
  };

  private handlePointerUp = (): void => {
    this.pointerDown = false;
  };

  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const realDt = this.lastNow === 0 ? 1 / 60 : Math.min((now - this.lastNow) / 1000, 0.25);
    this.lastNow = now;
    if (this.settings.idle) return;

    this.resize();

    const dt = this.settings.paused ? 0 : Math.min(realDt, MAX_DT) * this.settings.speed;
    this.time += dt;

    // Pointer smoothing runs in real time so the cursor still feels live while paused.
    const ease = 1 - Math.exp(-realDt * 12);
    const prevX = this.pointer.x;
    const prevY = this.pointer.y;
    this.pointer.x += (this.pointerTarget.x - this.pointer.x) * ease;
    this.pointer.y += (this.pointerTarget.y - this.pointer.y) * ease;
    this.pointerVelocity.x = (this.pointer.x - prevX) / realDt;
    this.pointerVelocity.y = (this.pointer.y - prevY) / realDt;
    this.pointerActive +=
      ((this.pointerInside ? 1 : 0) - this.pointerActive) * (1 - Math.exp(-realDt * 4));

    if (!this.instance || this.failed) return;

    // Paused (reduced motion): every frame would come out the same, and the canvas keeps showing the
    // last one it presented. Draw again only when the size or the copy's box moves.
    if (this.settings.paused) {
      this.measureCopy();
      const key = `${this.width}x${this.height}@${this.pixelRatio}:${this.copyRect.join(",")}`;
      if (key === this.stillKey) return;
      this.stillKey = key;
    } else {
      this.stillKey = "";
    }

    this.writeFrame(dt);

    try {
      this.instance.frame({
        time: this.time,
        dt,
        width: this.width,
        height: this.height,
        pixelRatio: this.pixelRatio,
        pointer: { x: this.pointer.x, y: this.pointer.y },
        pointerActive: this.pointerActive,
        pointerDown: this.pointerDown,
        presses: this.presses,
        press: { x: this.press.x, y: this.press.y },
        copyRect: this.copyRect,
      });
    } catch (error) {
      this.fail(describe(error));
    }
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
