import { expect, test } from "@playwright/test";

// Token colors asserted below (DESIGN.md): dark bg #0C0D10 = rgb(12,13,16),
// light bg #FBFAF7 = rgb(251,250,247), dark accent #E8A33D = rgb(232,163,61).

test.describe("profile render", () => {
  test("renders the handle, spec sheet and footer", async ({ page }) => {
    const res = await page.goto("/antfu");
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(/antfu/);
    await expect(page.locator("h1.handle")).toContainText("antfu");
    const spec = page.locator("table.spec").first();
    await expect(spec).toContainText("Editor");
    await expect(spec).toContainText("VS Code");
    await expect(page.locator(".foot")).toContainText("npx ymmv-cli antfu");
  });

  test("the diff form navigates to the diff and remembers the entered handle", async ({ page }) => {
    await page.goto("/antfu");
    await page.fill(".diff-cta input", "bardisty");
    await page.press(".diff-cta input", "Enter");
    await expect(page).toHaveURL(/\/antfu\/vs\/bardisty$/);
    await page.goto("/antfu");
    await expect(page.locator(".diff-cta input")).toHaveValue("bardisty");
  });

  test("the diff form blocks empty and invalid handles, strips a leading @", async ({ page }) => {
    await page.goto("/antfu");
    await page.press(".diff-cta input", "Enter");
    await expect(page).toHaveURL(/\/antfu$/); // empty submit stays put…
    await expect(page.locator(".diff-cta input")).toBeFocused(); // …and refocuses the input
    await page.fill(".diff-cta input", "..");
    await page.press(".diff-cta input", "Enter");
    await expect(page).toHaveURL(/\/antfu$/); // dot-segments must never navigate
    await page.fill(".diff-cta input", "@bardisty");
    await page.press(".diff-cta input", "Enter");
    await expect(page).toHaveURL(/\/antfu\/vs\/bardisty$/);
  });

  test("the foot command click-copies to the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/antfu");
    await page.click(".foot .install");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe("npx ymmv-cli antfu");
  });

  test("a 1-key edge profile still renders a spec table (no awkward empty block)", async ({
    page,
  }) => {
    // xsstest has one curated entry (dotfiles) + extras — the table must still render.
    await page.goto("/xsstest");
    await expect(page.locator("table.spec").first()).toBeVisible();
  });
});

test.describe("landing", () => {
  test("the example profile groups dotfiles under stack, exactly like a live profile", async ({
    page,
  }) => {
    await page.goto("/");
    const stack = page.locator("table.spec").first();
    await expect(stack).toContainText("Dotfiles");
    await expect(stack).toContainText("github.com/octocat/dotfiles");
  });
});

test.describe("routing", () => {
  test("301s a renamed handle to the current one (HTML + JSON)", async ({ request }) => {
    const html = await request.get("/antfuold", { maxRedirects: 0 });
    expect(html.status()).toBe(301);
    expect(html.headers().location).toBe("/antfu");

    const json = await request.get("/api/v1/u/antfuold", { maxRedirects: 0 });
    expect(json.status()).toBe(301);
    expect(json.headers().location).toBe("/api/v1/u/antfu");
  });

  test("404s an unknown handle with the friendly empty state", async ({ page }) => {
    const res = await page.goto("/ghosthandle");
    expect(res?.status()).toBe(404);
    // Not-found carries a SHORT TTL so a freshly published handle isn't edge-cached-missing for long.
    expect(res?.headers()["cache-control"]).toContain("s-maxage=10");
    await expect(page.locator(".empty-msg")).toContainText("no ymmv profile for");
  });

  test("sends the edge-cache header on a profile read", async ({ request }) => {
    const res = await request.get("/antfu");
    expect(res.headers()["cache-control"]).toContain("stale-while-revalidate");
  });

  test("302s a native ?you= form submit to the canonical diff URL", async ({ request }) => {
    // the script-failed fallback: a native GET submit must still reach the diff
    const res = await request.get("/antfu?you=bardisty", { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers().location).toBe("/antfu/vs/bardisty");
    // invalid shapes fall through to the profile instead of redirecting
    const bad = await request.get("/antfu?you=..", { maxRedirects: 0 });
    expect(bad.status()).toBe(200);
  });
});

test.describe("themes (dark-primary + light)", () => {
  test("honors prefers-color-scheme: dark", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/antfu");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(12, 13, 16)");
  });

  test("honors prefers-color-scheme: light", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/antfu");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(251, 250, 247)");
    // the dark-band fix itself: the html canvas (painted past a short body on mobile
    // overscroll) must follow the theme, not just the body
    const htmlBg = await page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    );
    expect(htmlBg).toBe("rgb(251, 250, 247)");
    // the no-FOUC head script must set the browser-UI color pre-paint, not just the click path
    const metaColor = await page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    );
    expect(metaColor).toBe("#fbfaf7");
  });

  test("the toggle flips and persists the theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/antfu");
    await page.click("#theme-toggle");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    // poll past the 0.3s background transition until it settles on the light token
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe("rgb(251, 250, 247)");
    const stored = await page.evaluate(() => localStorage.getItem("ymmv-theme"));
    expect(stored).toBe("light");
    // the browser-UI color (mobile toolbar/overscroll canvas) follows the toggle
    const metaColor = await page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    );
    expect(metaColor).toBe("#fbfaf7");
    // and back to dark — the sync reads the computed --bg token, both directions must hold
    await page.click("#theme-toggle");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
        ),
      )
      .toBe("#0c0d10");
    // stored choice must beat the system preference on the next pre-paint load
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const metaReload = await page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    );
    expect(metaReload).toBe("#0c0d10");
  });
});

test.describe("the 3-column diff", () => {
  test("counts differences and spends amber only on real differences", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const res = await page.goto("/antfu/vs/bardisty");
    // both sides live → the long-lived edge policy (the nudge test pins the short side)
    expect(res?.headers()["cache-control"]).toContain("s-maxage=30");
    // 13-key taxonomy: theme + version-manager differ, prompt shared (seed.sql arithmetic)
    await expect(page.locator(".foot")).toContainText("8 differ");
    await expect(page.locator(".foot")).toContainText("5 shared");

    const changedYours = page.locator("tr.changed .yours").first();
    const changedTheirs = page.locator("tr.changed .theirs").first();
    const sameYours = page.locator("tr.same .yours").first();
    const changedColor = await changedYours.evaluate((el) => getComputedStyle(el).color);
    const theirsColor = await changedTheirs.evaluate((el) => getComputedStyle(el).color);
    const sameColor = await sameYours.evaluate((el) => getComputedStyle(el).color);
    expect(changedColor).toBe("rgb(232, 163, 61)"); // amber on a difference
    expect(theirsColor).toBe(changedColor); // a difference is symmetric — both sides amber
    expect(sameColor).not.toBe(changedColor); // same rows recede — never amber
  });

  test("links both handles, offers a swap, and lists extras uncompared", async ({ page }) => {
    await page.goto("/antfu/vs/bardisty");
    await expect(page.locator("h1.url a").first()).toHaveAttribute("href", "/antfu");
    await expect(page.locator("h1.url a").nth(1)).toHaveAttribute("href", "/bardisty");
    await expect(page.locator(".foot a")).toHaveAttribute("href", "/bardisty/vs/antfu");
    // extras render dimmed + uncounted below the table (free labels don't diff)
    const extras = page.locator("table.extras-dim");
    await expect(extras).toContainText("Keyboard = HHKB Pro 2");
    await expect(extras).toContainText("Launcher = Raycast");
    // diff cells strip the https scheme for display but keep the full URL in the title
    const urlSpan = page.locator('tr.changed .theirs span[title^="https://"]').first();
    await expect(urlSpan).toHaveText(/^github\.com\/antfu/);
    await expect(urlSpan).toHaveAttribute(
      "title",
      "https://github.com/antfu/dotfiles-but-with-a-very-long-path/blob/main/config",
    );
  });

  test("a scheme-only dotfiles difference renders both values raw, never as equal strings", async ({
    page,
  }) => {
    // plainuser: github.com/plain/dots (bare) vs collide: https://github.com/plain/dots —
    // verbatim-compared, so the row differs; stripping would display two identical values,
    // and the collide guard must render both raw instead
    await page.goto("/plainuser/vs/collide");
    await expect(page.locator(".foot")).toContainText("1 differ");
    await expect(page.locator(".foot")).toContainText("2 shared");
    await expect(page.locator("tr.changed .theirs")).toHaveText("github.com/plain/dots");
    await expect(page.locator("tr.changed .yours")).toHaveText("https://github.com/plain/dots");
  });

  test("nudges to publish when the viewer has no profile", async ({ page }) => {
    const res = await page.goto("/antfu/vs/ghostviewer");
    await expect(page.locator(".nudge")).toContainText("publish yours to diff");
    await expect(page.locator("h1.handle")).toContainText("antfu"); // still shows the viewed profile
    // the nudge must stay short-cached like a 404 — the viewer may publish seconds later
    expect(res?.headers()["cache-control"]).toContain("s-maxage=10");
  });

  test("diff extras HTML-escape user labels/values and never link javascript:", async ({
    page,
  }) => {
    page.on("dialog", () => {
      throw new Error("a script in a diff extra executed");
    });
    await page.goto("/antfu/vs/xsstest");
    await expect(page.locator("table.extras-dim")).toContainText("Bio <script>alert(1)</script>");
    expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
  });

  test("omits the extras block entirely when neither side has extras", async ({ page }) => {
    await page.goto("/plainuser/vs/plainuser");
    await expect(page.locator(".foot")).toContainText("0 differ");
    expect(await page.locator("table.extras-dim").count()).toBe(0);
  });

  test("301s a renamed viewed-handle to the canonical diff URL (preserves the viewer)", async ({
    request,
  }) => {
    const res = await request.get("/antfuold/vs/bardisty", { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers().location).toBe("/antfu/vs/bardisty");
  });

  test("301s a renamed viewer to the canonical diff URL (preserves who is viewed)", async ({
    request,
  }) => {
    const res = await request.get("/bardisty/vs/antfuold", { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers().location).toBe("/bardisty/vs/antfu");
  });

  test("404s a diff against an unknown profile", async ({ page }) => {
    const res = await page.goto("/ghosthandle/vs/bardisty");
    expect(res?.status()).toBe(404);
    await expect(page.locator(".empty-msg")).toContainText("no ymmv profile for");
  });
});

test.describe("long values + safety", () => {
  test("a long URL value wraps instead of overflowing the page", async ({ page }) => {
    await page.goto("/antfu");
    const link = page.getByRole("link", { name: /dotfiles-but-with-a-very-long-path/ });
    await expect(link).toBeVisible();
    // display drops the scheme (wraps at the value column, not after "https://") — the href keeps it
    await expect(link).toHaveText(/^github\.com\//);
    await expect(link).toHaveAttribute(
      "href",
      "https://github.com/antfu/dotfiles-but-with-a-very-long-path/blob/main/config",
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1); // no horizontal scrollbar => it wrapped
  });

  test("external profile links carry rel=noreferrer (no Referer leak to the destination)", async ({
    page,
  }) => {
    await page.goto("/antfu");
    const link = page.getByRole("link", { name: /dotfiles-but-with-a-very-long-path/ });
    const rel = await link.getAttribute("rel");
    expect(rel).toContain("noreferrer");
    expect(rel).toContain("noopener"); // don't regress the existing reverse-tabnabbing guard
  });

  test("HTML-escapes user values and never emits a javascript: link", async ({ page }) => {
    page.on("dialog", () => {
      throw new Error("a script in a profile value executed");
    });
    await page.goto("/xsstest");
    await expect(page.locator("body")).toContainText("<script>alert(1)</script>");
    expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
  });
});

test.describe("fonts (Astro Fonts API)", () => {
  test("self-hosts and preloads the three above-the-fold faces", async ({ page, request }) => {
    await page.goto("/antfu");

    // Exactly three preloads: display (Cabinet Grotesk 800), sans (General Sans 500), mono (Geist Mono
    // latin). If a build-time provider fetch degrades a family it emits zero faces and its preload
    // vanishes, so this count is the tripwire for a silent font-degradation build.
    const preloads = page.locator('link[rel="preload"][as="font"]');
    await expect(preloads).toHaveCount(3);
    const hrefs = await preloads.evaluateAll((ls) => ls.map((l) => l.getAttribute("href") ?? ""));
    expect(hrefs.every((h) => h.startsWith("/_astro/fonts/") && h.endsWith(".woff2"))).toBe(true);

    // The hashed woff2 actually serves, same-origin (no runtime third-party request).
    const font = await request.get(hrefs[0]);
    expect(font.status()).toBe(200);
    expect(font.headers()["content-type"]).toContain("font/woff2");

    // The Fonts API owns --font-display/-sans/-mono; ymmv.css consumes them. Verify the real families
    // are wired (a renamed cssVariable or a dropped <Font> would break this).
    const vars = await page.evaluate(() => {
      const r = getComputedStyle(document.documentElement);
      return [
        r.getPropertyValue("--font-display"),
        r.getPropertyValue("--font-sans"),
        r.getPropertyValue("--font-mono"),
      ];
    });
    expect(vars[0]).toContain("Cabinet Grotesk");
    expect(vars[1]).toContain("General Sans");
    expect(vars[2]).toContain("Geist Mono");
  });
});
