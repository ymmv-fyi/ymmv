// The divergence field — the landing hero's signature motif, animated.
//
// A field of thin horizontal "roads" (lanes). Most run parallel and recede; every so often one
// forks, and the diverging branch lights up amber before fading — the diff, drawn. Hovering the
// install CTA pulls the field toward it: forks spawn near the button and pulses accelerate.
//
// Progressive enhancement only. The hero ships a static SVG of the same motif; this module swaps
// in the canvas ONLY when motion is allowed (no prefers-reduced-motion) and JS runs. Forced-colors
// hides the canvas in CSS (canvas pixels ignore forced palettes); the SVG uses currentColor and
// survives. Pauses off-screen (IntersectionObserver) and on hidden tabs (visibilitychange).
//
// Colors come from the live CSS tokens (--accent, --faint) so the theme toggle re-skins the field
// without a repaint seam; a MutationObserver on html[data-theme] refreshes the cache.

const field = document.querySelector<HTMLElement>("[data-divergence]");
const canvas = field?.querySelector<HTMLCanvasElement>("canvas");
const cta = document.querySelector<HTMLElement>(".install");

if (field && canvas) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const ctx = canvas.getContext("2d");

  // --- token cache (refreshed on theme flip) ---
  let inkColor = "";
  let accentColor = "";
  const readTokens = () => {
    const s = getComputedStyle(document.documentElement);
    inkColor = s.getPropertyValue("--faint").trim() || "#8a8272";
    accentColor = s.getPropertyValue("--accent").trim() || "#ffab2e";
  };
  new MutationObserver(readTokens).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  readTokens();

  // --- geometry ---
  const LANE_GAP = 26; // px between roads
  const FORK_SLOPE = 0.22; // rise/run of a diverging branch
  let w = 0;
  let h = 0;
  let dpr = 1;
  let lanes: number[] = [];

  const resize = () => {
    const r = field.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.max(3, Math.floor(h / LANE_GAP));
    const pad = (h - (count - 1) * LANE_GAP) / 2;
    lanes = Array.from({ length: count }, (_, i) => pad + i * LANE_GAP);
  };
  new ResizeObserver(resize).observe(field);
  resize();

  // --- moving parts ---
  interface Fork {
    lane: number; // index of the origin lane
    x: number; // fork point
    dir: 1 | -1; // branch up or down
    age: number; // seconds alive
    life: number; // seconds total
  }
  interface Pulse {
    lane: number;
    x: number;
    speed: number; // px/s
  }
  const forks: Fork[] = [];
  const pulses: Pulse[] = [];
  let hoverPull = 0; // 0..1, eased while the CTA is hovered

  const spawnFork = (nearX?: number) => {
    if (lanes.length < 2 || forks.length >= 7) return;
    const lane = 1 + Math.floor(Math.random() * (lanes.length - 2));
    const x = nearX != null ? nearX + (Math.random() - 0.5) * 160 : Math.random() * (w * 0.8);
    forks.push({
      lane,
      x: Math.max(20, Math.min(w - 140, x)),
      dir: Math.random() < 0.5 ? 1 : -1,
      age: 0,
      life: 2.2 + Math.random() * 2.4,
    });
  };
  const spawnPulse = () => {
    if (!lanes.length || pulses.length >= 6) return;
    pulses.push({
      lane: Math.floor(Math.random() * lanes.length),
      x: -40,
      speed: 90 + Math.random() * 140,
    });
  };

  // --- CTA attraction ---
  // ctaCenter persists after the pointer leaves: the bend is driven by the eased hoverPull,
  // and it needs the attractor position while easing back OUT — nulling it on leave would
  // snap the field straight in one frame.
  let ctaCenter: { x: number; y: number } | null = null;
  let ctaHovered = false;
  if (cta) {
    cta.addEventListener("mouseenter", () => {
      const c = cta.getBoundingClientRect();
      const f = field.getBoundingClientRect();
      ctaCenter = { x: c.left - f.left + c.width / 2, y: c.top - f.top + c.height / 2 };
      ctaHovered = true;
    });
    cta.addEventListener("mouseleave", () => {
      ctaHovered = false;
    });
  }

  // --- draw ---
  const draw = (dt: number) => {
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    hoverPull += ((ctaHovered ? 1 : 0) - hoverPull) * Math.min(1, dt * 5);

    // Bent lane geometry. EVERYTHING that rides a lane must sample this — if forks or pulses
    // used the resting y while the lanes bend toward the hovered CTA, the amber would float
    // off its road.
    const laneY = (i: number, x: number): number => {
      const y = lanes[i];
      if (!ctaCenter || hoverPull <= 0.01) return y;
      const dx = (x - ctaCenter.x) / 220;
      return y + Math.exp(-dx * dx) * (ctaCenter.y - y) * 0.12 * hoverPull;
    };
    const traceLane = (i: number, x0: number, x1: number) => {
      ctx.moveTo(x0, laneY(i, x0));
      for (let x = x0 + 12; x < x1; x += 12) ctx.lineTo(x, laneY(i, x));
      ctx.lineTo(x1, laneY(i, x1));
    };

    // lanes: quiet constant roads, bending faintly toward the hovered CTA
    ctx.lineWidth = 1;
    ctx.strokeStyle = inkColor;
    ctx.globalAlpha = 0.28;
    for (let i = 0; i < lanes.length; i++) {
      ctx.beginPath();
      traceLane(i, 0, w);
      ctx.stroke();
    }

    // pulses: brief brighter segments traveling along a lane (data on the road)
    ctx.globalAlpha = 0.5;
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.x += p.speed * (1 + hoverPull * 1.5) * dt;
      if (p.x > w + 60) {
        pulses.splice(i, 1);
        continue;
      }
      if (lanes[p.lane] == null) continue;
      const grad = ctx.createLinearGradient(p.x - 56, 0, p.x, 0);
      grad.addColorStop(0, "transparent");
      grad.addColorStop(1, inkColor);
      ctx.strokeStyle = grad;
      ctx.beginPath();
      traceLane(p.lane, p.x - 56, p.x);
      ctx.stroke();
    }

    // forks: the amber divergence — grows out, holds, fades
    for (let i = forks.length - 1; i >= 0; i--) {
      const f = forks[i];
      f.age += dt;
      if (f.age >= f.life) {
        forks.splice(i, 1);
        continue;
      }
      const y = lanes[f.lane];
      const yTo = lanes[f.lane + f.dir];
      if (y == null || yTo == null) continue;
      const t = f.age / f.life;
      const fade = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      const run = Math.abs(yTo - y) / FORK_SLOPE;
      const TAIL = 90; // how far the branch rides the new road
      // the tip travels the WHOLE path (diagonal, then tail) at constant speed — never
      // snap the tail in as one piece the moment the branch reaches the new lane.
      // Lengths use the resting geometry; DRAWING samples laneY so the branch follows
      // its (possibly bent) origin and destination roads.
      const diagLen = Math.hypot(run, yTo - y);
      const dist = (diagLen + TAIL) * Math.min(1, t * 3); // full length by the first third
      const target = f.lane + f.dir;
      // the diagonal blends from the origin road's curve to the destination road's curve
      const branchY = (x: number) => {
        const g = Math.min(1, (x - f.x) / run);
        return laneY(f.lane, x) * (1 - g) + laneY(target, x) * g;
      };
      ctx.strokeStyle = accentColor;
      ctx.globalAlpha = 0.75 * fade;
      ctx.beginPath();
      ctx.moveTo(f.x, laneY(f.lane, f.x));
      const diagTipX = f.x + run * Math.min(1, dist / diagLen);
      for (let x = f.x + 10; x < diagTipX; x += 10) ctx.lineTo(x, branchY(x));
      ctx.lineTo(diagTipX, branchY(diagTipX));
      if (dist > diagLen) {
        const tailTipX = f.x + run + (dist - diagLen);
        for (let x = f.x + run + 12; x < tailTipX; x += 12) ctx.lineTo(x, laneY(target, x));
        ctx.lineTo(tailTipX, laneY(target, tailTipX));
      }
      ctx.stroke();
      // the fork point itself: a small marker, like the diff dot — pinned to the bent road
      ctx.globalAlpha = 0.9 * fade;
      ctx.fillStyle = accentColor;
      ctx.beginPath();
      ctx.arc(f.x, laneY(f.lane, f.x), 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  // --- run loop with spawn cadence, gated on visibility + viewport + motion pref ---
  let raf = 0;
  let last = 0;
  let running = false;
  let inView = true;
  let forkTimer = 0;
  let pulseTimer = 0;

  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    forkTimer -= dt;
    pulseTimer -= dt;
    const forkEvery = ctaHovered ? 0.5 : 2.4;
    if (forkTimer <= 0) {
      spawnFork(ctaHovered && ctaCenter ? ctaCenter.x - 80 : undefined);
      forkTimer = forkEvery * (0.6 + Math.random() * 0.8);
    }
    if (pulseTimer <= 0) {
      spawnPulse();
      pulseTimer = 1.4 * (0.5 + Math.random());
    }
    draw(dt);
    raf = requestAnimationFrame(frame);
  };
  const start = () => {
    if (running || reduced.matches || !inView || document.visibilityState === "hidden") return;
    running = true;
    field.dataset.anim = ""; // CSS: shows the canvas, hides the static SVG
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const stop = (clearMotif = false) => {
    if (running) cancelAnimationFrame(raf);
    running = false;
    if (clearMotif) delete field.dataset.anim; // back to the static SVG
  };

  new IntersectionObserver(
    (entries) => {
      inView = entries[0]?.isIntersecting ?? true;
      inView ? start() : stop();
    },
    { rootMargin: "64px" },
  ).observe(field);
  document.addEventListener("visibilitychange", () => {
    document.visibilityState === "hidden" ? stop() : start();
  });
  reduced.addEventListener("change", () => {
    reduced.matches ? stop(true) : start();
  });

  start();
}
