import { type BrowserContext, expect, type Page, test } from "@playwright/test";

// Token colors asserted below (DESIGN.md): dark bg #0E0C09 = rgb(14,12,9),
// light bg #F6F3EA = rgb(246,243,234), dark accent #FFAB2E = rgb(255,171,46).

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

  test("renders an example diff (octocat vs hubot) with counts, handles, and a missing row", async ({
    page,
  }) => {
    await page.goto("/");
    const diff = page.locator("table.diff");
    await expect(diff).toBeVisible();
    // both handles head the two value columns
    await expect(diff.locator("thead")).toContainText("octocat");
    await expect(diff.locator("thead")).toContainText("hubot");
    // 7 differ / 6 shared — the hubot persona math (also catches any accidental alias-fold)
    const foot = page.locator(".diff-foot");
    await expect(foot).toContainText("7 differ");
    await expect(foot).toContainText("6 shared");
    // the example diff is static → no live "swap" navigation
    await expect(foot.locator("a")).toHaveCount(0);
    // dotfiles: octocat has it (left/theirs), hubot doesn't → em-dash on the right (yours) cell
    const dotfiles = diff.locator("tbody tr", { hasText: "Dotfiles" });
    await expect(dotfiles.locator(".theirs")).toContainText("github.com/octocat/dotfiles");
    await expect(dotfiles.locator(".yours .missing")).toHaveText("—");
    // example mode suppresses the "Extras (not compared)" block — octocat carries a Keyboard extra,
    // so this guards that the !example gate (not an empty-extras coincidence) is what hides it
    await expect(page.locator("table.extras-dim")).toHaveCount(0);
  });

  test("spends amber only on the differing rows of the example diff", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    const diff = page.locator("table.diff");
    const changedColor = await diff
      .locator("tr.changed .yours")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    const sameColor = await diff
      .locator("tr.same .yours")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(changedColor).toBe("rgb(255, 171, 46)"); // amber on a difference
    expect(sameColor).not.toBe(changedColor); // same rows recede — never amber
  });

  test("keeps a single h1 (the wordmark) despite the added example diff", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveClass(/wordmark/);
  });

  test("the footer is a labelled quick reference", async ({ page }) => {
    await page.goto("/");
    const foot = page.locator(".site-foot");
    await expect(foot.locator(".foot-h")).toContainText("Reference");
    await expect(foot).toContainText("json"); // the data-row note is filled in
    await expect(foot).toContainText("code + issues"); // the source-row note
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
    expect(json.headers()["access-control-allow-origin"]).toBe("*");
  });

  test("the JSON read is cross-origin readable and preflightable (the open-data contract)", async ({
    request,
  }) => {
    // Headers must survive the REAL worker + Astro routing, not just the unit-called handler.
    const res = await request.get("/api/v1/u/antfu");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(res.headers()["access-control-allow-origin"]).toBe("*");

    // A browser client with any custom request header preflights first; without this handler the
    // OPTIONS would fall through to the HTML 404 and the fetch dies as an opaque CORS TypeError.
    const preflight = await request.fetch("/api/v1/u/antfu", { method: "OPTIONS" });
    expect(preflight.status()).toBe(204);
    expect(preflight.headers()["access-control-allow-origin"]).toBe("*");
    expect(preflight.headers()["access-control-allow-methods"]).toContain("GET");
  });

  test("404s an unknown handle with the friendly empty state", async ({ page }) => {
    const res = await page.goto("/ghosthandle");
    expect(res?.status()).toBe(404);
    // Not-found carries a SHORT TTL so a freshly published handle isn't edge-cached-missing for long.
    expect(res?.headers()["cache-control"]).toContain("s-maxage=10");
    await expect(page.locator(".empty-msg")).toContainText("no ymmv profile for");
  });

  test("the reserved handle 404 never resolves to a profile, on HTML or JSON", async ({
    page,
    request,
  }) => {
    // The seed holds a LIVE published row for handle `404` (github_id 6006) — the shape a
    // grandfathered claim would leave behind. Astro serves the static 404.astro page at /404
    // ahead of the dynamic [handle] page, so HTML can never render that profile; the JSON
    // endpoint must agree. Drop the seed row and this test passes vacuously.
    //
    // The HTML half pins Astro's static-route precedence (a structural fact, true with or
    // without the reservation). The JSON half is the actual guard on RESERVED_ROUTES: without
    // `404` reserved it returns 200 + the profile.
    const html = await page.goto("/404");
    expect(html?.status()).toBe(404);
    // The generic not-found page, never the spec sheet a live profile renders.
    await expect(page.locator("p.empty-msg")).toContainText("no page here.");
    await expect(page.locator("table.spec")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Neovim");

    const json = await request.get("/api/v1/u/404", { maxRedirects: 0 });
    expect(json.status()).toBe(404);
    expect(await json.text()).not.toContain("Neovim");
    // The 404 is a machine-readable JSON envelope (a consumer's res.json() must never throw).
    expect(json.headers()["content-type"]).toContain("application/json");
    expect(json.headers()["access-control-allow-origin"]).toBe("*");
    expect(await json.json()).toEqual({ error: "not_found" });
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
  // the browser-UI color mirror (mobile toolbar/overscroll) — asserted alongside data-theme
  const themeColor = (page: Page) =>
    page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    );
  // two same-context tabs on /antfu under a dark system preference — the cross-tab fixtures
  // (pages close with the per-test context; no explicit cleanup needed)
  async function openTwoTabs(context: BrowserContext): Promise<[Page, Page]> {
    const a = await context.newPage();
    const b = await context.newPage();
    await a.emulateMedia({ colorScheme: "dark" });
    await b.emulateMedia({ colorScheme: "dark" });
    await a.goto("/antfu");
    await b.goto("/antfu");
    return [a, b];
  }

  test("honors prefers-color-scheme: dark", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/antfu");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(14, 12, 9)");
  });

  test("honors prefers-color-scheme: light", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/antfu");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(246, 243, 234)");
    // the dark-band fix itself: the html canvas (painted past a short body on mobile
    // overscroll) must follow the theme, not just the body
    const htmlBg = await page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    );
    expect(htmlBg).toBe("rgb(246, 243, 234)");
    // the no-FOUC head script must set the browser-UI color pre-paint, not just the click path
    const metaColor = await page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    );
    expect(metaColor).toBe("#f6f3ea");
  });

  test("the toggle flips and persists the theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/antfu");
    await page.click("#theme-toggle");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    // poll past the 0.3s background transition until it settles on the light token
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe("rgb(246, 243, 234)");
    const stored = await page.evaluate(() => localStorage.getItem("ymmv-theme"));
    expect(stored).toBe("light");
    // the browser-UI color (mobile toolbar/overscroll canvas) follows the toggle
    const metaColor = await page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    );
    expect(metaColor).toBe("#f6f3ea");
    // and back to dark — the sync reads the computed --bg token, both directions must hold
    await page.click("#theme-toggle");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
        ),
      )
      .toBe("#0e0c09");
    // stored choice must beat the system preference on the next pre-paint load
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const metaReload = await page.evaluate(() =>
      document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    );
    expect(metaReload).toBe("#0e0c09");
  });

  test("a toggle in one tab resyncs another open tab (cross-tab storage)", async ({ context }) => {
    const [a, b] = await openTwoTabs(context);
    await expect(a.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(b.locator("html")).toHaveAttribute("data-theme", "dark");
    // toggle in A → B follows via the storage listener: data-theme, the toggle state, and the
    // browser-UI color all flip in the tab that never received the click.
    await a.click("#theme-toggle");
    await expect(b.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(b.locator("#theme-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => themeColor(b)).toBe("#f6f3ea");
  });

  test("clearing the stored theme in one tab reverts another to the system preference", async ({
    context,
  }) => {
    const [a, b] = await openTwoTabs(context);
    await a.click("#theme-toggle"); // store an explicit light choice; B follows it cross-tab
    await expect(b.locator("html")).toHaveAttribute("data-theme", "light");
    // remove the stored choice in A → B's storage listener sees newValue null and falls back to system
    await a.evaluate(() => localStorage.removeItem("ymmv-theme"));
    await expect(b.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(b.locator("#theme-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  test("localStorage.clear() in one tab also reverts another to the system preference", async ({
    context,
  }) => {
    const [a, b] = await openTwoTabs(context);
    await a.click("#theme-toggle");
    await expect(b.locator("html")).toHaveAttribute("data-theme", "light");
    // clear() fires storage with key null — the listener must treat that as a wiped choice too
    await a.evaluate(() => localStorage.clear());
    await expect(b.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(b.locator("#theme-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  test("re-applies the theme on a BFCache restore (synthetic pageshow)", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/antfu");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    // A real back-forward restore never re-runs the pre-paint script, so a choice stored after
    // this page painted leaves it stale. The pageshow(persisted) path must re-resolve all three.
    await page.evaluate(() => {
      localStorage.setItem("ymmv-theme", "light");
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("#theme-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(await themeColor(page)).toBe("#f6f3ea");
  });

  test("a live system-preference change moves the theme only with no stored choice", async ({
    page,
  }) => {
    // Regression on the simplified matchMedia change callback (it had no coverage before).
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/antfu");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    // no stored choice → a live system flip to light is followed
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("#theme-toggle")).toHaveAttribute("aria-pressed", "true");
    // store an explicit light choice, then flip the system to dark — the stored choice must win
    await page.evaluate(() => localStorage.setItem("ymmv-theme", "light"));
    await page.emulateMedia({ colorScheme: "dark" });
    // positive propagation signal (not a fixed sleep): the media flip has reached the page —
    // any (erroneous) change handler has therefore fired — before the negative assertion
    await page.waitForFunction(() => matchMedia("(prefers-color-scheme: dark)").matches);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});

test.describe("install command (progressive copy button)", () => {
  test("promotes the span to a keyboard-operable copy button; Enter copies", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/antfu");
    const install = page.locator(".foot .install");
    await expect(install).toHaveAttribute("role", "button");
    await expect(install).toHaveAttribute("tabindex", "0");
    await expect(install).toHaveAttribute("aria-label", /Copy install command: npx ymmv-cli/);
    await install.focus();
    await page.keyboard.press("Enter");
    // wait for the visible success state first — the async writeText races a one-shot readText
    await expect(install).toHaveAttribute("data-copied", "");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("npx ymmv-cli antfu");
  });

  test("Space copies and does not scroll the page", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/antfu");
    // give the page room to scroll below the foot so a default Space keypress WOULD move it…
    await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "3000px";
      document.body.appendChild(spacer);
    });
    // …and prove it genuinely can scroll in this viewport
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight),
    ).toBe(true);
    const install = page.locator(".foot .install");
    await install.focus();
    const before = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("Space");
    // the copy result proves the keydown handler ran before the scroll assertion
    await expect(install).toHaveAttribute("data-copied", "");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("npx ymmv-cli antfu");
    // Chromium schedules the space-bar scroll on a later frame — read after two rAFs so a
    // missing preventDefault cannot false-pass on a too-early read
    const after = await page.evaluate(
      () =>
        new Promise<number>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.scrollY))),
        ),
    );
    expect(after).toBe(before);
  });

  test("Tab moves focus off the control (only activation keys are intercepted)", async ({
    page,
  }) => {
    await page.goto("/antfu");
    const install = page.locator(".foot .install");
    await install.focus();
    await page.keyboard.press("Tab");
    // a broadened preventDefault gate in the keydown handler would trap Tab on the control
    expect(await install.evaluate((el) => el === document.activeElement)).toBe(false);
  });

  test("announces a failure when the clipboard write is denied", async ({ page }) => {
    await page.goto("/antfu");
    const install = page.locator(".foot .install");
    await expect(install).toHaveAttribute("role", "button"); // wired before we break the write
    // policy-denied clipboard (NotAllowedError): the promoted control must not silently no-op
    await page.evaluate(() => {
      navigator.clipboard.writeText = () =>
        Promise.reject(new DOMException("Write permission denied.", "NotAllowedError"));
    });
    await install.focus();
    await page.keyboard.press("Enter");
    await expect(install.locator("[data-copy-status]")).toHaveText("Copy failed");
    // the failure never fakes the success glyph
    expect(await install.getAttribute("data-copied")).toBeNull();
  });
});

test.describe("install command without JS", () => {
  test.use({ javaScriptEnabled: false });
  test("stays plain selectable text with no dead control", async ({ page }) => {
    await page.goto("/antfu");
    const install = page.locator(".foot .install");
    await expect(install).toBeVisible();
    await expect(install).toContainText("npx ymmv-cli antfu");
    // a SPAN, not a native <button> — a button revert would pass the null-attribute checks
    // below while being exactly the focusable dead control this guards against
    expect(await install.evaluate((el) => el.tagName)).toBe("SPAN");
    // never promoted → no button semantics a keyboard/AT user could reach and find inert
    expect(await install.getAttribute("role")).toBeNull();
    expect(await install.getAttribute("tabindex")).toBeNull();
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
    expect(changedColor).toBe("rgb(255, 171, 46)"); // amber on a difference
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

    // Exactly three preloads: display (Martian Mono variable), mono (IBM Plex Mono 400 latin), serif
    // (Instrument Serif italic). If a build-time provider fetch degrades a family it emits zero faces
    // and its preload vanishes, so this count is the tripwire for a silent font-degradation build.
    const preloads = page.locator('link[rel="preload"][as="font"]');
    await expect(preloads).toHaveCount(3);
    const hrefs = await preloads.evaluateAll((ls) => ls.map((l) => l.getAttribute("href") ?? ""));
    expect(hrefs.every((h) => h.startsWith("/_astro/fonts/") && h.endsWith(".woff2"))).toBe(true);

    // The hashed woff2 actually serves, same-origin (no runtime third-party request).
    const font = await request.get(hrefs[0]);
    expect(font.status()).toBe(200);
    expect(font.headers()["content-type"]).toContain("font/woff2");

    // The Fonts API owns --font-display/-mono/-serif; ymmv.css consumes them. Verify the real families
    // are wired (a renamed cssVariable or a dropped <Font> would break this).
    const vars = await page.evaluate(() => {
      const r = getComputedStyle(document.documentElement);
      return [
        r.getPropertyValue("--font-display"),
        r.getPropertyValue("--font-mono"),
        r.getPropertyValue("--font-serif"),
      ];
    });
    expect(vars[0]).toContain("Martian Mono");
    expect(vars[1]).toContain("IBM Plex Mono");
    expect(vars[2]).toContain("Instrument Serif");
  });
});
