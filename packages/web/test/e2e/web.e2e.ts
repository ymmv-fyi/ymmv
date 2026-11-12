import { expect, test } from "@playwright/test";

// Token colors asserted below (DESIGN.md → Color): bg #050607 = rgb(5,6,7), accent (mint)
// #3EE6A8 = rgb(62,230,168). The site is dark only.
const BG = "rgb(5, 6, 7)";
const MINT = "rgb(62, 230, 168)";

// The compare form's error line (Profile.astro), shown on a miss by the script or the ?you= handler.
const YOU_HINT = "Enter a GitHub handle: letters, digits and single hyphens, up to 39.";

// One input table for both copies of the compare form's rule: the script (Profile.astro) and the
// native ?you= handler ([handle]/index.astro). A drift between the two fails one path here.
// The strip set is deliberately narrow: www. and a path after the handle are misses.
const YOU_CASES: [input: string, expected: string | null][] = [
  ["bardisty", "bardisty"],
  ["  @bardisty ", "bardisty"],
  ["https://github.com/bardisty", "bardisty"],
  ["http://github.com/bardisty/", "bardisty"],
  ["GitHub.com/bardisty", "bardisty"],
  ["https://ymmv.fyi/bardisty", "bardisty"],
  ["ymmv.fyi/bardisty/", "bardisty"],
  ["https://www.github.com/bardisty", null],
  ["https://github.com/bardisty/ymmv", null],
  ["github.com/", null],
  ["not a handle", null],
  ["..", null],
  ["a".repeat(40), null],
  ["", null],
];

test.describe("profile render", () => {
  test("renders the handle, the stack, the extras and the foot commands", async ({ page }) => {
    const res = await page.goto("/antfu");
    expect(res?.status()).toBe(200);
    // URL-as-title, pinned exactly (a partial revert to the old "antfu - ymmv.fyi" shape would
    // still match a loose /antfu/ regex)
    await expect(page).toHaveTitle("ymmv.fyi/antfu");
    await expect(page.locator("h1.handle")).toHaveText("antfu");
    await expect(page.locator(".profile-meta")).toHaveText("Updated 28 Jun 2026");
    const stack = page.locator("table.stack");
    await expect(stack).toContainText("Editor");
    await expect(stack).toContainText("VS Code");
    // the person's own lines are labelled as theirs, and as uncompared
    await expect(page.locator(".extras-h")).toHaveText("Extras");
    await expect(page.locator(".extras-note")).toHaveText(
      "Lines added by hand. A diff doesn’t compare them.",
    );
    await expect(page.locator(".extras-rows")).toContainText("HHKB Pro 2");
    await expect(page.locator(".view-cmd .install")).toHaveAttribute(
      "data-copy",
      "npx ymmv-cli@latest antfu",
    );
    await expect(page.locator(".make-cmd .install")).toHaveAttribute(
      "data-copy",
      "npx ymmv-cli@latest",
    );
  });

  test("both foot commands click-copy to the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/antfu");
    await page.click(".view-cmd .install");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "npx ymmv-cli@latest antfu",
    );
    await page.click(".make-cmd .install");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("npx ymmv-cli@latest");
  });

  test("compares in place, links the full diff, and remembers the handle", async ({ page }) => {
    await page.goto("/antfu");
    await page.fill("#compare-you", "bardisty");
    await page.press("#compare-you", "Enter");
    const table = page.locator("table.stack");
    await expect(table).toHaveClass(/is-compared/);
    // the page did not navigate; the stack gained the visitor's column
    await expect(page).toHaveURL(/\/antfu$/);
    await expect(page.locator("[data-stack-you]")).toHaveText("bardisty");
    // the same counts the full diff page shows (seed.sql arithmetic)
    await expect(page.locator(".compare-status > span")).toHaveText([
      "7 differ",
      "5 shared",
      "1 only antfu",
    ]);
    await expect(page.locator(".compare-status a")).toHaveAttribute("href", "/antfu/vs/bardisty");
    // differences spend the accent on both sides; shared rows recede
    const editor = page.locator("tr.d").filter({ hasText: "Editor" });
    await expect(editor.locator("td")).toHaveText(["VS Code", "Zed"]);
    const theirs = await editor
      .locator("td")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(theirs).toBe(MINT);
    expect(
      await editor
        .locator("td")
        .nth(1)
        .evaluate((el) => getComputedStyle(el).color),
    ).toBe(MINT);
    const shared = page.locator("tr.s").filter({ hasText: "Prompt" }).locator("td").first();
    expect(await shared.evaluate((el) => getComputedStyle(el).color)).not.toBe(MINT);
    // announced for screen readers, with the counts
    await expect(page.locator("#compare-msg")).toHaveText(
      "Compared with bardisty: 7 differ, 5 shared, 1 only antfu.",
    );
    // a valid compare is remembered and prefills the next visit, which never compares by itself
    await page.goto("/antfu");
    await expect(page.locator("#compare-you")).toHaveValue("bardisty");
    await expect(page.locator("table.stack")).not.toHaveClass(/is-compared/);
  });

  test("Clear and Escape put the stack back", async ({ page }) => {
    await page.goto("/antfu");
    await page.fill("#compare-you", "bardisty");
    await page.press("#compare-you", "Enter");
    await expect(page.locator("table.stack")).toHaveClass(/is-compared/);
    await page.press("#compare-you", "Escape");
    await expect(page.locator("table.stack")).not.toHaveClass(/is-compared/);
    await expect(page.locator("[data-stack-you]")).toBeHidden();
    await page.press("#compare-you", "Enter");
    await expect(page.locator("table.stack")).toHaveClass(/is-compared/);
    await page.click("[data-compare-clear]");
    await expect(page.locator("table.stack")).not.toHaveClass(/is-compared/);
    await expect(page.locator("#compare-you")).toHaveValue("");
    await expect(page.locator("#compare-you")).toBeFocused();
  });

  test("a handle with no profile gets the install command, and is not remembered", async ({
    page,
  }) => {
    await page.goto("/antfu");
    await page.fill("#compare-you", "ghostviewer");
    await page.press("#compare-you", "Enter");
    await expect(page.locator("#compare-msg")).toHaveText(
      "No ymmv profile for ghostviewer yet. Publish yours, then compare:",
    );
    await expect(page.locator("[data-compare-miss] .install")).toBeVisible();
    await expect(page.locator("table.stack")).not.toHaveClass(/is-compared/);
    expect(await page.evaluate(() => localStorage.getItem("ymmv-you"))).toBeNull();
  });

  test("compared cells strip bidi controls and never show a difference as equal strings", async ({
    page,
  }) => {
    // plainuser's shell is "zsh"; collide's is "zsh" + U+202E (seed.sql)
    await page.goto("/plainuser");
    await page.fill("#compare-you", "collide");
    await page.press("#compare-you", "Enter");
    const shell = page.locator("tbody tr").filter({ hasText: "Shell" });
    await expect(shell).toHaveClass("d");
    await expect(shell.locator("td")).toHaveText(["zsh", "zsh\uFFFD"]);
  });

  test("an invalid handle: three signals, described and announced; a valid one clears it", async ({
    page,
  }) => {
    await page.goto("/antfu");
    const input = page.locator("#compare-you");
    const msg = page.locator("#compare-msg");
    // the live region is in the tree before any miss, so the first message is announced
    await expect(msg).toHaveAttribute("aria-live", "polite");
    await expect(msg).toHaveText("");
    await input.fill("not a handle");
    await input.press("Enter");
    await expect(page).toHaveURL(/\/antfu$/);
    await expect(input).toBeFocused();
    await expect(msg).toHaveText(YOU_HINT);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAccessibleDescription(YOU_HINT);
    expect(await msg.evaluate((el) => getComputedStyle(el, "::before").content)).not.toBe("none");
    // a miss is never remembered: only a valid compare writes the prefill
    expect(await page.evaluate(() => localStorage.getItem("ymmv-you"))).toBeNull();
    // still invalid while the value is: the error stays
    await input.pressSequentially("x");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    // valid: it clears the moment it is
    await input.fill("");
    await input.pressSequentially("bardisty");
    await expect(input).not.toHaveAttribute("aria-invalid");
    await expect(msg).toHaveText("");
  });

  test("keyboard only: Tab to the input, Enter on a bad value, and the error describes it", async ({
    page,
  }) => {
    await page.goto("/antfu");
    const input = page.locator("#compare-you");
    for (let i = 0; i < 20 && !(await input.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press("Tab");
    }
    await expect(input).toBeFocused();
    await page.keyboard.type("no/such");
    await page.keyboard.press("Enter");
    await expect(input).toBeFocused();
    await expect(input).toHaveAccessibleDescription(YOU_HINT);
  });

  test("the compare form and the ?you= handler agree on every input", async ({ page, request }) => {
    for (const [value, expected] of YOU_CASES) {
      await page.goto("/antfu");
      await page.evaluate(() => localStorage.clear());
      await page.fill("#compare-you", value);
      const fetched = expected
        ? page.waitForRequest((r) => r.url().endsWith(`/api/v1/u/${expected}`))
        : null;
      await page.press("#compare-you", "Enter");
      const native = await request.get(`/antfu?you=${encodeURIComponent(value)}`, {
        maxRedirects: 0,
      });
      if (expected) {
        await fetched;
        expect(native.status(), value).toBe(302);
        expect(native.headers().location, value).toBe(`/antfu/vs/${expected}`);
      } else {
        await expect(page.locator("#compare-msg"), value).toHaveText(YOU_HINT);
        expect(native.status(), value).toBe(200);
        const body = await native.text();
        expect(body, value).toContain(YOU_HINT);
        expect(body, value).toContain('aria-invalid="true"');
      }
    }
  });

  test("a pasted profile URL is not cut short by the input", async ({ page }) => {
    // a maxlength of 39 would truncate the paste before the script strips the prefix
    await page.goto("/antfu");
    await page.fill("#compare-you", "https://github.com/bardisty");
    await expect(page.locator("#compare-you")).toHaveValue("https://github.com/bardisty");
    await page.press("#compare-you", "Enter");
    await expect(page.locator("[data-stack-you]")).toHaveText("bardisty");
    expect(await page.evaluate(() => localStorage.getItem("ymmv-you"))).toBe("bardisty");
  });

  test("a server-rendered error is not contradicted by the remembered handle", async ({ page }) => {
    await page.goto("/antfu");
    await page.evaluate(() => localStorage.setItem("ymmv-you", "bardisty"));
    await page.goto("/antfu?you=not%20a%20handle");
    await expect(page.locator("#compare-msg")).toHaveText(YOU_HINT);
    await expect(page.locator("#compare-you")).toHaveValue("");
    // a plain visit still prefills
    await page.goto("/antfu");
    await expect(page.locator("#compare-you")).toHaveValue("bardisty");
  });

  test("the profile without ?you= renders no error", async ({ request }) => {
    const body = await (await request.get("/antfu")).text();
    expect(body).not.toContain(YOU_HINT);
    expect(body).not.toContain('aria-invalid="true"');
  });

  test("a 1-key edge profile still renders a stack (no awkward empty block)", async ({ page }) => {
    // xsstest has one curated entry (dotfiles) + extras — the stack must still render.
    await page.goto("/xsstest");
    await expect(page.locator("table.stack")).toBeVisible();
  });

  test("a live profile carries no landing-only preview marker", async ({ page }) => {
    await page.goto("/antfu");
    await expect(page.locator(".spec-more")).toHaveCount(0);
    await expect(page.locator(".is-example")).toHaveCount(0);
  });

  test("the canonical names the profile path even when a query string rides along", async ({
    page,
  }) => {
    // an invalid ?you= falls through to the profile render — the canonical must not echo the query
    await page.goto("/antfu?you=..");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://ymmv.fyi/antfu",
    );
  });

  test("alias spellings consolidate to the resolved canonical; junk mints none", async ({
    page,
  }) => {
    // case-insensitive resolution must not let /ANTFU declare itself canonical
    await page.goto("/ANTFU");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://ymmv.fyi/antfu",
    );
    await expect(page).toHaveTitle("ymmv.fyi/antfu");
    // a 404 carries no canonical at all (pathname-derived canonicals were an SEO-spam vector)
    await page.goto("/ghosthandle");
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
    // and a garbage segment never wears the URL dress in the title (handle-shape guard)
    await page.goto("/a..b");
    await expect(page).toHaveTitle("ymmv.fyi");
  });
});

test.describe("landing", () => {
  test("carries the short edge-cache policy", async ({ request }) => {
    const res = await request.get("/");
    expect(res.headers()["cache-control"]).toContain("s-maxage=10");
  });

  test("the page pane groups dotfiles under stack, exactly like a live profile", async ({
    page,
  }) => {
    await page.goto("/");
    const stack = page.locator(".page-pane .stack");
    await expect(stack).toContainText("Dotfiles");
    await expect(stack).toContainText("github.com/octocat/dotfiles");
  });

  test("the page pane is an honest preview: truncated rows + a '+ N more' marker", async ({
    page,
  }) => {
    await page.goto("/");
    const stack = page.locator(".page-pane .stack");
    // truncation is real (Multiplexer is elided from the preview)...
    await expect(stack).not.toContainText("Multiplexer");
    await expect(page.locator(".spec-more")).toContainText("+ 7 more");
  });

  test("the compare panel is the real diff, in example mode", async ({ page }) => {
    await page.goto("/");
    const panel = page.locator(".panel .diff-page");
    await expect(panel.locator("table.diff")).toHaveCount(1);
    await expect(panel.locator(".diff-h")).toHaveText("how hubot differs from octocat");
    await expect(panel.locator(".diff-counts > span")).toHaveText([
      "5 differ",
      "7 shared",
      "1 only octocat",
    ]);
    // example mode: no command, no swap link, no links at all, and no second h1
    await expect(panel.locator(".install")).toHaveCount(0);
    await expect(panel.locator("a")).toHaveCount(0);
    await expect(page.locator("h1")).toHaveCount(1);
  });

  test("the terminal pane shows the CLI transcript (detect, confirm, published link)", async ({
    page,
  }) => {
    await page.goto("/");
    const term = page.locator(".term");
    await expect(term).toBeVisible();
    await expect(term).toContainText("npx ymmv-cli@latest");
    await expect(term).toContainText("Publish to ymmv.fyi/octocat? [Y/n/e=edit]");
    await expect(term).toContainText("Published octocat");
    // the accent marks exactly what the CLI renders in its accent: the published link
    await expect(term.locator(".t-link")).toHaveText("ymmv.fyi/octocat");
  });

  test("the whole run is in the server markup; the intro only adds motion", async ({ page }) => {
    // reduced motion: the script never arms the intro, and every line is visible at once
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator(".demo")).not.toHaveAttribute("data-play", "");
    const last = page.locator(".term .tl").last();
    await expect(last).toContainText("Published octocat");
    expect(await last.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  });

  test("the intro plays once per session", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await expect(page.locator(".demo")).toHaveAttribute("data-play", "");
    // the run finishes: its last line lands
    await expect
      .poll(() =>
        page
          .locator(".term .tl")
          .last()
          .evaluate((el) => getComputedStyle(el).opacity),
      )
      .toBe("1");
    await page.reload();
    await expect(page.locator(".demo")).not.toHaveAttribute("data-play", "");
  });

  test("the hero links one real, live profile", async ({ page }) => {
    await page.goto("/");
    const live = page.locator(".live-link a");
    await expect(live).toHaveAttribute("href", "/bardisty");
    await expect(live).toContainText("ymmv.fyi/bardisty");
    // and the target actually resolves — a renamed/unpublished handle would ship a dead hero link
    const res = await page.goto("/bardisty");
    expect(res?.status()).toBe(200);
    await expect(page.locator("h1.handle")).toContainText("bardisty");
  });

  test("never scrolls sideways on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("carries a canonical URL and JSON-LD", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://ymmv.fyi/",
    );
    const ld = page.locator('script[type="application/ld+json"]');
    await expect(ld).toHaveCount(1);
    expect(JSON.parse((await ld.textContent()) ?? "")).toMatchObject({
      "@type": "SoftwareApplication",
      name: "ymmv",
    });
  });

  test("spends the accent only on the published link inside the terminal", async ({ page }) => {
    await page.goto("/");
    const term = page.locator(".term");
    const linkColor = await term.locator(".t-link").evaluate((el) => getComputedStyle(el).color);
    const dimColor = await term
      .locator(".t-dim")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(linkColor).toBe(MINT); // the accent on the published link
    expect(dimColor).not.toBe(linkColor); // scaffolding recedes — never the accent
  });

  test("keeps a single h1: the claim, not the logo", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveClass(/claim/);
    await expect(page.locator("h1")).toContainText("one command");
    await expect(page.locator(".site-nav .logo")).toHaveAttribute("href", "/");
  });

  test("the sky is decoration: hidden from assistive tech, never in the way of a click", async ({
    page,
  }) => {
    await page.goto("/");
    const canvas = page.locator(".hero-canvas");
    // no WebGPU (or a failed start) removes the canvas and leaves the CSS glow; either way is fine
    if ((await canvas.count()) === 1) {
      await expect(canvas).toHaveAttribute("aria-hidden", "true");
      expect(await canvas.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
    }
    await expect(page.locator(".hero .claim")).toBeVisible();
  });

  test("the nav carries the install command only once the hero's has scrolled away", async ({
    page,
  }) => {
    await page.goto("/");
    const navCmd = page.locator(".site-nav .nav-cmd .install");
    await expect(navCmd).toBeHidden();
    await page.locator(".site-foot").scrollIntoViewIfNeeded();
    await expect(navCmd).toBeVisible();
    await expect(navCmd).toHaveAttribute("data-copy", "npx ymmv-cli@latest");
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(navCmd).toBeHidden();
  });

  test("the footer links the API contract and the privacy page", async ({ page }) => {
    await page.goto("/");
    const foot = page.locator(".site-foot");
    // a consumer who discovers the API from a page needs a path to the contract
    await expect(
      foot.locator('a[href="https://github.com/ymmv-fyi/ymmv/blob/main/docs/api.md"]'),
    ).toHaveText("API docs");
    await expect(foot.locator('a[href="/privacy"]')).toHaveText("Privacy");
  });
});

test.describe("privacy page", () => {
  test("answers 200 with the URL title, the breadcrumb h1 and its own canonical", async ({
    page,
  }) => {
    const res = await page.goto("/privacy");
    expect(res?.status()).toBe(200);
    // the short policy: request-invariant HTML that names hashed /_astro assets, like the landing
    expect(res?.headers()["cache-control"]).toContain("s-maxage=10");
    await expect(page).toHaveTitle("ymmv.fyi/privacy");
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator(".url h1.handle")).toHaveText("privacy");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://ymmv.fyi/privacy",
    );
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
    await expect(page.locator(".doc h2").first()).toHaveText("What the server stores");
  });

  test("each section heading's accessible name is its plain text", async ({ page }) => {
    // a decorative mark added in CSS (::before) would land in the role name, not in textContent
    await page.goto("/privacy");
    await expect(
      page.getByRole("heading", { level: 2, name: "What the server stores", exact: true }),
    ).toHaveCount(1);
  });

  test("the site footer links it", async ({ page }) => {
    await page.goto("/");
    const link = page.locator('.site-foot a[href="/privacy"]');
    await expect(link).toHaveText("Privacy");
    await link.click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.locator(".url h1.handle")).toHaveText("privacy");
  });

  test("ends on where to ask, with the private advisory form for anything sensitive", async ({
    page,
  }) => {
    await page.goto("/privacy");
    const last = page.locator(".doc > p").last();
    await expect(last.locator('a[href="https://github.com/ymmv-fyi/ymmv/issues"]')).toHaveCount(1);
    await expect(
      last.locator('a[href="https://github.com/ymmv-fyi/ymmv/security/advisories/new"]'),
    ).toHaveCount(1);
  });

  test("is Worker-rendered, so the canonical-origin redirect reaches it", async ({ request }) => {
    // A prerendered page would be a static asset, served ahead of the Worker: www would then
    // answer 200 here instead of redirecting, and the page would never get HSTS.
    const www = await request.get("/privacy", {
      headers: { host: "www.ymmv.fyi" },
      maxRedirects: 0,
    });
    expect(www.status()).toBe(301);
    expect(www.headers().location).toBe("https://ymmv.fyi/privacy");
  });

  test("never scrolls sideways on a small phone", async ({ page }) => {
    // code spans and prose links wrap anywhere by CSS, so this catches the rest: a long unbroken
    // token in plain prose, a <b>, a heading or the breadcrumb, or a new element wider than 320px
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/privacy");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("a diff's count line wraps a 39-character handle on a small phone", async ({ page }) => {
    // `N only <handle>` is the one count that carries a handle, and a GitHub handle can be 39
    // characters with no hyphen to break at
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/longhandlewithnohyphenstobreakatanywher/vs/bardisty");
    await expect(page.locator(".diff-counts")).toContainText(
      "1 only longhandlewithnohyphenstobreakatanywher",
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
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

  test("www and http redirect to https://ymmv.fyi in the built Worker; localhost is left alone", async ({
    request,
  }) => {
    // The unit suite calls onRequest directly; only this proves Astro loads src/middleware.ts.
    const www = await request.get("/antfu?x=1", {
      headers: { host: "www.ymmv.fyi" },
      maxRedirects: 0,
    });
    expect(www.status()).toBe(301);
    expect(www.headers().location).toBe("https://ymmv.fyi/antfu?x=1");

    // An unmatched path renders through Astro's error route; the redirect must still win.
    const unmatched = await request.get("/a/b", {
      headers: { host: "www.ymmv.fyi" },
      maxRedirects: 0,
    });
    expect(unmatched.status()).toBe(301);
    expect(unmatched.headers().location).toBe("https://ymmv.fyi/a/b");

    // Apex where only the scheme differs: wrangler dev always hands the Worker an http: URL, so
    // a 301 proves nothing between the Worker entry and the middleware rewrites the scheme.
    // Whether production's request.url carries a visitor's http: is checked only by the
    // DEPLOY.md smoke. wrangler dev also rewrites response headers naming the request host back
    // to its own http origin, so the Location's scheme isn't checkable here.
    const apex = await request.get("/antfu?x=1", {
      headers: { host: "ymmv.fyi" },
      maxRedirects: 0,
    });
    expect(apex.status()).toBe(301);
    expect(apex.headers().location).toMatch(/:\/\/ymmv\.fyi\/antfu\?x=1$/);

    // Local http must stay reachable and must never be pinned to HTTPS.
    const local = await request.get("/", { maxRedirects: 0 });
    expect(local.status()).toBe(200);
    expect(local.headers()["strict-transport-security"]).toBeUndefined();
  });

  test("a write or a credential on plain http to ymmv.fyi is refused in the built Worker, not redirected", async ({
    request,
  }) => {
    // Same http: URL wrangler dev always hands the Worker (above). A 308 here would let a client
    // that keeps `authorization` across the upgrade resend its bearer in cleartext on every call.
    const write = await request.post("/api/v1/profile", {
      headers: { host: "ymmv.fyi" },
      data: {},
      maxRedirects: 0,
    });
    expect(write.status()).toBe(403);
    expect(write.headers().location).toBeUndefined();
    expect((await write.json()).error).toBe("https_required");

    const bearer = await request.get("/api/v1/auth/whoami", {
      headers: { host: "www.ymmv.fyi", authorization: "Bearer ymmv_not_a_real_token" },
      maxRedirects: 0,
    });
    expect(bearer.status()).toBe(403);
    expect((await bearer.json()).error).toBe("https_required");
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

  test("whoami is mounted in the built Worker: a garbage bearer is a JSON 401, never the HTML 404", async ({
    request,
  }) => {
    // The unit suite calls the handler directly; only this proves Astro routes GET to it. The CLI
    // reads a 404 here as "this server has no identity lookup", so a mis-mounted route would fail
    // every YMMV_TOKEN command with the wrong diagnosis.
    const res = await request.get("/api/v1/auth/whoami", {
      headers: { authorization: "Bearer ymmv_not_a_real_token" },
    });
    expect(res.status()).toBe(401);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(res.headers()["access-control-allow-origin"]).toBeUndefined();
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("whoami returns the CLI contract for a live bearer through the built Worker", async ({
    request,
  }) => {
    // seed.sql holds the SHA-256 of this token for github_id 2002. The body IS the CLI contract:
    // a missing github_id makes the CLI's parseIdentity refuse and fails every YMMV_TOKEN command.
    const res = await request.get("/api/v1/auth/whoami", {
      headers: { authorization: "Bearer ymmv_e2e_seed_token_2002" },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(await res.json()).toEqual({ github_id: 2002, handle: "bardisty" });
  });

  test("the own-profile read is mounted in the built Worker: a garbage bearer is a JSON 401", async ({
    request,
  }) => {
    // GET shares a route file with POST/DELETE; this proves Astro exports it through the build.
    const res = await request.get("/api/v1/profile", {
      headers: { authorization: "Bearer ymmv_not_a_real_token" },
    });
    expect(res.status()).toBe(401);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(res.headers()["access-control-allow-origin"]).toBeUndefined();
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("the own-profile read returns the live bearer's profile with an ETag, never cached", async ({
    request,
  }) => {
    const res = await request.get("/api/v1/profile", {
      headers: { authorization: "Bearer ymmv_e2e_seed_token_2002" },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-store");
    const body = (await res.json()) as { handle: string; updated_at: string };
    expect(body.handle).toBe("bardisty");
    expect(res.headers().etag).toBe(`"${body.updated_at}"`);
  });

  test("the public JSON read carries the same ETag next to its edge-cache policy", async ({
    request,
  }) => {
    const res = await request.get("/api/v1/u/bardisty");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { updated_at: string };
    expect(res.headers().etag).toBe(`"${body.updated_at}"`);
  });

  test("404s an unknown handle with the friendly empty state", async ({ page }) => {
    const res = await page.goto("/ghosthandle");
    expect(res?.status()).toBe(404);
    // Not-found carries a SHORT TTL so a freshly published handle isn't edge-cached-missing for long.
    expect(res?.headers()["cache-control"]).toContain("s-maxage=10");
    await expect(page.locator(".empty-msg")).toHaveText("no ymmv profile for ghosthandle yet.");
    await expect(page).toHaveTitle("ymmv.fyi/ghosthandle");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      "No ymmv profile for ghosthandle yet. Publish yours with npx ymmv-cli@latest.",
    );
  });

  test("a reserved segment renders exactly the catch-all 404, never a person's empty state", async ({
    page,
  }) => {
    // /login, /api and the CLI verbs are no one's handle: they must not read as someone who
    // hasn't published yet, nor offer "Publish yours". The reference is the catch-all 404.astro.
    const read = async (path: string) => {
      const res = await page.goto(path);
      return {
        status: res?.status(),
        cache: res?.headers()["cache-control"],
        title: await page.title(),
        description: await page.locator('meta[name="description"]').getAttribute("content"),
        h1: await page.locator("h1.handle").innerText(),
        msg: await page.locator(".empty-msg").innerText(),
      };
    };
    const catchAll = await read("/no/such/route");
    expect(catchAll).toMatchObject({
      status: 404,
      title: "ymmv.fyi/404",
      h1: "404",
      msg: "no page here.",
    });
    expect(catchAll.cache).toContain("s-maxage=10");
    // isReserved lowercases, so /Login is reserved too; /login/vs/x is the diff page's [handle] side
    for (const path of ["/login", "/Login", "/api", "/logout", "/delete", "/login/vs/bardisty"]) {
      expect(await read(path), path).toEqual(catchAll);
      await expect(page.locator("body"), path).not.toContainText("Publish yours");
    }
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
    expect(html?.headers()["cache-control"]).toContain("s-maxage=10");
    // The generic not-found page, never the stack a live profile renders.
    await expect(page.locator("p.empty-msg")).toContainText("no page here.");
    await expect(page).toHaveTitle("ymmv.fyi/404");
    await expect(page.locator("table.stack")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Neovim");

    const json = await request.get("/api/v1/u/404", { maxRedirects: 0 });
    expect(json.status()).toBe(404);
    expect(await json.text()).not.toContain("Neovim");
    // The 404 is a machine-readable JSON envelope (a consumer's res.json() must never throw).
    expect(json.headers()["content-type"]).toContain("application/json");
    expect(json.headers()["access-control-allow-origin"]).toBe("*");
    expect(await json.json()).toEqual({ error: "not_found" });
  });

  test("an unmatched route 404s with the short edge-cache policy", async ({ request }) => {
    // Multi-segment paths miss every route and land on the catch-all 404.astro.
    const res = await request.get("/no/such/route");
    expect(res.status()).toBe(404);
    expect(res.headers()["cache-control"]).toContain("s-maxage=10");
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

test.describe("dark only", () => {
  for (const colorScheme of ["dark", "light"] as const) {
    test(`stays dark under prefers-color-scheme: ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.goto("/antfu");
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(BG);
      // the html canvas (painted past a short body on mobile overscroll) matches the body
      expect(
        await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
      ).toBe(BG);
      // and the browser UI color is the same bg
      expect(
        await page.evaluate(() =>
          document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
        ),
      ).toBe("#050607");
    });
  }

  test("has no theme toggle and keeps no theme choice", async ({ page }) => {
    await page.goto("/antfu");
    await expect(page.locator("#theme-toggle")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("ymmv-theme"))).toBeNull();
  });
});

test.describe("install command (progressive copy button)", () => {
  test("promotes the span to a keyboard-operable copy button; Enter copies", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/antfu");
    const install = page.locator(".view-cmd .install");
    await expect(install).toHaveAttribute("role", "button");
    await expect(install).toHaveAttribute("tabindex", "0");
    await expect(install).toHaveAttribute("aria-label", "Copy command: npx ymmv-cli@latest antfu");
    await install.focus();
    await page.keyboard.press("Enter");
    // wait for the visible success state first — the async writeText races a one-shot readText
    await expect(install).toHaveAttribute("data-copied", "");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "npx ymmv-cli@latest antfu",
    );
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
    const install = page.locator(".view-cmd .install");
    await install.focus();
    const before = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("Space");
    // the copy result proves the keydown handler ran before the scroll assertion
    await expect(install).toHaveAttribute("data-copied", "");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "npx ymmv-cli@latest antfu",
    );
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
    const install = page.locator(".view-cmd .install");
    await install.focus();
    await page.keyboard.press("Tab");
    // a broadened preventDefault gate in the keydown handler would trap Tab on the control
    expect(await install.evaluate((el) => el === document.activeElement)).toBe(false);
  });

  test("announces a failure when the clipboard write is denied", async ({ page }) => {
    await page.goto("/antfu");
    const install = page.locator(".view-cmd .install");
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

test.describe("compare form without JS", () => {
  test.use({ javaScriptEnabled: false });
  test("a bad ?you= renders the profile with the error showing, never echoing the input", async ({
    page,
  }) => {
    const res = await page.goto(`/antfu?you=${encodeURIComponent("zqxzqx<b>")}`);
    expect(res?.status()).toBe(200);
    await expect(page.locator("#compare-msg")).toBeVisible();
    await expect(page.locator("#compare-msg")).toHaveText(YOU_HINT);
    await expect(page.locator("#compare-you")).toHaveAttribute("aria-invalid", "true");
    expect(await res?.text()).not.toContain("zqxzqx");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://ymmv.fyi/antfu",
    );
    // a plain visit shows nothing
    await page.goto("/antfu");
    await expect(page.locator("#compare-msg")).toHaveText("");
  });

  test("a valid handle submits natively to the full diff", async ({ page }) => {
    await page.goto("/antfu");
    await page.fill("#compare-you", "bardisty");
    await page.click(".compare-btn");
    await expect(page).toHaveURL(/\/antfu\/vs\/bardisty$/);
  });
});

test.describe("install command without JS", () => {
  test.use({ javaScriptEnabled: false });
  test("stays plain selectable text with no dead control", async ({ page }) => {
    await page.goto("/antfu");
    const install = page.locator(".view-cmd .install");
    await expect(install).toBeVisible();
    await expect(install).toContainText("npx ymmv-cli@latest antfu");
    // a SPAN, not a native <button> — a button revert would pass the null-attribute checks
    // below while being exactly the focusable dead control this guards against
    expect(await install.evaluate((el) => el.tagName)).toBe("SPAN");
    // never promoted → no button semantics a keyboard/AT user could reach and find inert
    expect(await install.getAttribute("role")).toBeNull();
    expect(await install.getAttribute("tabindex")).toBeNull();
  });
});

test.describe("the diff page", () => {
  test("counts differences and spends the accent only on real differences", async ({ page }) => {
    const res = await page.goto("/antfu/vs/bardisty");
    // both sides live → the long-lived edge policy (the nudge test pins the short side)
    expect(res?.headers()["cache-control"]).toContain("s-maxage=30");
    // 13-key taxonomy: theme + version-manager differ, prompt shared, and dotfiles is antfu's
    // alone, counted apart (seed.sql arithmetic)
    const counts = page.locator(".diff-counts > span");
    await expect(counts).toHaveText(["7 differ", "5 shared", "1 only antfu"]);
    // rows keep the taxonomy order (the profile's and the CLI's), never sorted by verdict
    await expect(page.locator("table.diff tbody th").first()).toContainText("Editor");
    await expect(page.locator("table.diff tbody th").nth(1)).toContainText("OS");

    const changedYours = page.locator("tr.d .mine").first();
    const changedTheirs = page.locator("tr.d .theirs").first();
    const sameYours = page.locator("tr.s .mine").first();
    const changedColor = await changedYours.evaluate((el) => getComputedStyle(el).color);
    const theirsColor = await changedTheirs.evaluate((el) => getComputedStyle(el).color);
    const sameColor = await sameYours.evaluate((el) => getComputedStyle(el).color);
    expect(changedColor).toBe(MINT); // the accent on a difference
    expect(theirsColor).toBe(changedColor); // a difference is symmetric — both sides
    expect(sameColor).not.toBe(changedColor); // same rows recede — never the accent

    // A field only one side filled in is no difference: a grey dot, a faint value, no accent.
    const one = page.locator("tr.o").filter({ hasText: "Dotfiles" });
    await expect(one.locator("th .sr-only")).toHaveText("only antfu:");
    const oneDot = await one
      .locator(".diff-dot")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const oneValue = await one.locator(".theirs").evaluate((el) => getComputedStyle(el).color);
    const changedDot = await page
      .locator("tr.d .diff-dot")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(changedDot).toBe(MINT);
    expect(oneDot).not.toBe(changedDot);
    expect(oneValue).not.toBe(changedColor);
    expect(await one.locator(".diff-dot").evaluate((el) => getComputedStyle(el).visibility)).toBe(
      "visible",
    );
    // a shared row shows no dot: presence, not hue, marks the other two (WCAG 1.4.1)
    expect(
      await page
        .locator("tr.s .diff-dot")
        .first()
        .evaluate((el) => getComputedStyle(el).visibility),
    ).toBe("hidden");
    // the missing side reads "not set" to a screen reader, never "dash"
    await expect(one.locator(".mine .sr-only")).toHaveText("not set");
    await expect(one.locator(".mine .diff-missing")).toHaveAttribute("aria-hidden", "true");
  });

  test("links both handles, offers a swap, and lists extras uncompared", async ({ page }) => {
    await page.goto("/antfu/vs/bardisty");
    await expect(page).toHaveTitle("ymmv.fyi/antfu/vs/bardisty"); // URL-as-title, pinned exactly
    // the command that produced it sits under the h1: the CLI's `<a> vs <b>`, theirs first
    const cmd = page.locator(".diff-cmd .install");
    await expect(cmd).toHaveText("$ npx ymmv-cli@latest antfu vs bardisty");
    await expect(cmd).toHaveAttribute("data-copy", "npx ymmv-cli@latest antfu vs bardisty");
    // the copy control names what it copies; this command compares, it installs nothing
    await expect(cmd).toHaveAttribute(
      "aria-label",
      "Copy command: npx ymmv-cli@latest antfu vs bardisty",
    );
    await expect(page.locator("h1.diff-h")).toHaveText("how antfu differs from bardisty");
    await expect(page.locator("h1.diff-h a").first()).toHaveAttribute("href", "/antfu");
    await expect(page.locator("h1.diff-h a").nth(1)).toHaveAttribute("href", "/bardisty");
    await expect(page.locator(".diff-counts a")).toHaveAttribute("href", "/bardisty/vs/antfu");
    await expect(page.locator(".diff-counts a")).toHaveText("Swap sides");
    // the table is named by the h1
    await expect(page.locator("table.diff")).toHaveAttribute("aria-labelledby", "diff-h");
    // extras render dimmed + uncounted below the table, grouped by owner (free labels don't diff)
    const extras = page.locator(".diff-extras");
    await expect(extras.locator(".diff-x-who")).toHaveText(["antfu", "bardisty"]);
    const keyboard = extras.locator(".diff-x-row").filter({ hasText: "Keyboard" });
    await expect(keyboard.locator("dd")).toHaveText("HHKB Pro 2");
    await expect(extras.locator(".diff-x").nth(1)).toContainText("Launcher");
    await expect(extras.locator(".diff-x").nth(1)).toContainText("Raycast");
    expect(
      await extras.evaluate((el) => getComputedStyle(el.querySelector("dd") as Element).color),
    ).not.toBe(MINT);
    // diff cells strip the https scheme for display but keep the full URL in the title
    const urlSpan = page.locator('tr.o .theirs span[title^="https://"]').first();
    await expect(urlSpan).toHaveText(/^github\.com\/antfu/);
    await expect(urlSpan).toHaveAttribute(
      "title",
      "https://github.com/antfu/dotfiles-but-with-a-very-long-path/blob/main/config",
    );
  });

  test("a narrow screen keeps the longest one-word label on one line, level with its values", async ({
    page,
  }) => {
    // 320 is the WCAG reflow width and 375 the iPhone SE/mini; 401 sits just above the breakpoint
    // where the label column switches from a length back to 30%.
    for (const width of [320, 375, 401, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/antfu/vs/bardisty");
      // measure the self-hosted mono, not the metric-matched fallback it swaps in for
      await page.evaluate(() => document.fonts.ready);
      const row = page.locator("table.diff tbody tr").filter({ hasText: "Multiplexer" });
      const layout = await row.evaluate((tr) => {
        const k = tr.querySelector("th.diff-k") as HTMLElement;
        const text = [...k.childNodes].find(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
        );
        const range = document.createRange();
        range.selectNodeContents(text as Node);
        const value = tr.querySelector("td.theirs span") as HTMLElement;
        // the label (14px) and the value (15-17px) share a baseline, so their bottoms sit within
        // the larger face's extra descent of each other
        return {
          lines: range.getClientRects().length,
          bottomDelta: range.getBoundingClientRect().bottom - value.getBoundingClientRect().bottom,
        };
      });
      expect(layout.lines, `at ${width}px`).toBe(1);
      expect(Math.abs(layout.bottomDelta), `at ${width}px`).toBeLessThan(4);
    }
  });

  test("the label column never pushes the diff past the page", async ({ page }) => {
    // under 400px the label column is a length, not 30%: sized value columns beside it would add
    // up to more than the table and scroll the page sideways
    for (const width of [320, 360, 400, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/antfu/vs/bardisty");
      await page.evaluate(() => document.fonts.ready);
      const box = await page.evaluate(() => {
        const table = document.querySelector("table.diff") as HTMLElement;
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          table: table.getBoundingClientRect().width,
          parent: (table.parentElement as HTMLElement).getBoundingClientRect().width,
        };
      });
      expect(box.overflow, `at ${width}px`).toBeLessThanOrEqual(0);
      expect(box.table, `at ${width}px`).toBeLessThanOrEqual(box.parent + 0.5);
    }
  });

  test("extras values start on the diff's value edge at every width", async ({ page }) => {
    // rendered text edges, not CSS widths: both read --diff-label, at 30% and at the phone length
    for (const width of [320, 375, 480, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/antfu/vs/bardisty");
      await page.evaluate(() => document.fonts.ready);
      const edges = await page.evaluate(() => {
        const textLeft = (el: Element) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return Math.min(...[...range.getClientRects()].map((r) => r.left));
        };
        return {
          diff: textLeft(document.querySelector("table.diff tbody td.theirs") as Element),
          extras: textLeft(document.querySelector(".diff-x-row dd") as Element),
        };
      });
      expect(Math.abs(edges.diff - edges.extras), `at ${width}px`).toBeLessThanOrEqual(1);
    }
  });

  test("extras wrap between words and path segments on a phone, never inside one", async ({
    page,
  }) => {
    const words = ["github.com", "antfu", "dotfiles", "HHKB", "Pro", "bardisty"];
    for (const width of [320, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/antfu/vs/bardisty");
      await page.evaluate(() => document.fonts.ready);
      // a word broken across lines has more than one client rect
      const broken = await page.locator(".diff-extras").evaluate((table, list) => {
        const found: string[] = [];
        const walker = document.createTreeWalker(table, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const text = node.textContent ?? "";
          for (const word of list) {
            for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
              const range = document.createRange();
              range.setStart(node, at);
              range.setEnd(node, at + word.length);
              if (range.getClientRects().length > 1) found.push(word);
            }
          }
        }
        return found;
      }, words);
      expect(broken, `at ${width}px`).toEqual([]);
      // the break points are <wbr>s: the link's text is still the one unbroken string
      await expect(
        page.locator('.diff-extras a[href="https://github.com/antfu/dotfiles"]'),
      ).toHaveText("github.com/antfu/dotfiles");
    }
  });

  test("a URL cell wraps between path segments on a phone, never inside a word that fits", async ({
    page,
  }) => {
    const text = "github.com/antfu/dotfiles-but-with-a-very-long-path/blob/main/config";
    const words = ["github.com", "antfu", "blob", "main", "config"];
    // at 320 the value column holds 8 characters: "github.com" is longer than a line there and
    // still breaks, like any segment wider than the column
    const fitting = new Map([
      [320, words.filter((word) => word.length <= 8)],
      [360, words],
      [375, words],
      [480, words],
    ]);
    for (const [width, list] of fitting) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/antfu/vs/bardisty");
      await page.evaluate(() => document.fonts.ready);
      const cell = page
        .locator("table.diff tbody tr")
        .filter({ hasText: "dotfiles" })
        .locator("td.theirs span");
      // a word broken across lines has more than one client rect
      const broken = await cell.evaluate((span, list) => {
        const found: string[] = [];
        const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const text = node.textContent ?? "";
          for (const word of list) {
            for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
              const range = document.createRange();
              range.setStart(node, at);
              range.setEnd(node, at + word.length);
              if (range.getClientRects().length > 1) found.push(word);
            }
          }
        }
        return found;
      }, list);
      expect(broken, `at ${width}px`).toEqual([]);
      // the break points are <wbr>s: the cell still reads, and copies, as the one unbroken
      // string, under the same full-URL title
      await expect(cell).toHaveText(text);
      expect(await cell.evaluate((span) => span.textContent)).toBe(text);
      await expect(cell).toHaveAttribute("title", `https://${text}`);
    }
  });

  test("the command follows the pair's order and copies the stored handles", async ({ page }) => {
    await page.goto("/bardisty/vs/antfu");
    const cmd = page.locator(".diff-cmd .install");
    await expect(cmd).toHaveAttribute("data-copy", "npx ymmv-cli@latest bardisty vs antfu");
    // the viewer segment resolves case-insensitively without a redirect: the copied command
    // carries the stored handle, never the raw URL segment
    await page.goto("/antfu/vs/BarDisty");
    await expect(cmd).toHaveAttribute("data-copy", "npx ymmv-cli@latest antfu vs bardisty");
  });

  test("a scheme-only dotfiles difference renders both values raw, never as equal strings", async ({
    page,
  }) => {
    // plainuser: github.com/plain/dots (bare) vs collide: https://github.com/plain/dots —
    // verbatim-compared, so the row differs; stripping would display two identical values,
    // and the collide guard must render both raw instead
    await page.goto("/plainuser/vs/collide");
    await expect(page.locator(".diff-counts")).toContainText("2 differ"); // dotfiles + the bidi shell row
    await expect(page.locator(".diff-counts")).toContainText("2 shared");
    const dotfiles = page.locator("tr.d").filter({ hasText: "dotfiles" });
    await expect(dotfiles.locator(".theirs")).toHaveText("github.com/plain/dots");
    await expect(dotfiles.locator(".mine")).toHaveText("https://github.com/plain/dots");
  });

  test("a bidi-only difference renders a visible U+FFFD marker, never two equal strings", async ({
    page,
  }) => {
    // plainuser: "zsh" vs collide: "zsh" + U+202E — stripping alone would show "zsh" twice on a
    // "differs" row, so the bidi collide rung marks the control instead
    await page.goto("/plainuser/vs/collide");
    const shell = page.locator("tr.d").filter({ hasText: "shell" });
    await expect(shell.locator(".theirs")).toHaveText("zsh");
    await expect(shell.locator(".mine")).toHaveText(`zsh${String.fromCodePoint(0xfffd)}`);
  });

  test("nudges to publish when the viewer has no profile", async ({ page }) => {
    const res = await page.goto("/antfu/vs/ghostviewer");
    const nudge = page.locator(".nudge");
    await expect(nudge.locator(".nudge-h")).toHaveText("No ymmv profile for ghostviewer yet.");
    await expect(nudge).toContainText(
      "If that’s you, publish yours and this page becomes the diff.",
    );
    // the call to action is the command itself, the way to make this page a diff
    await expect(nudge.locator(".install")).toHaveAttribute("data-copy", "npx ymmv-cli@latest");
    await expect(page.locator("h1.handle")).toContainText("antfu"); // still shows the viewed profile
    // the reason there's no diff comes first: the nudge sits above the profile
    const order = await page.evaluate(() => {
      const n = document.querySelector(".nudge") as Element;
      const h = document.querySelector("h1.handle") as Element;
      return n.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(order).toBeTruthy();
    // the nudge must stay short-cached like a 404 — the viewer may publish seconds later
    expect(res?.headers()["cache-control"]).toContain("s-maxage=10");
    // a transient 200 state: never canonical, never indexed (junk viewer segments must not
    // mint indexable ymmv.fyi URLs with attacker-shaped titles)
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  });

  test("diff extras HTML-escape user labels/values and never link javascript:", async ({
    page,
  }) => {
    page.on("dialog", () => {
      throw new Error("a script in a diff extra executed");
    });
    await page.goto("/antfu/vs/xsstest");
    await expect(page.locator(".diff-extras")).toContainText("Bio <script>alert(1)</script>");
    expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
  });

  test("says there's nothing to compare when neither side has a stack", async ({ page }) => {
    // seed.sql: extrasonly has one extra and no stack rows, blankslate has neither
    await page.goto("/extrasonly/vs/blankslate");
    await expect(page.locator("h1.diff-h")).toHaveText("how extrasonly differs from blankslate");
    await expect(page.locator(".diff-empty")).toHaveText(
      "Neither extrasonly nor blankslate has published a stack yet, so there’s nothing to compare.",
    );
    // no empty table, no "0 differ / 0 shared" counts, no swap to an equally empty page
    await expect(page.locator("table.diff")).toHaveCount(0);
    await expect(page.locator(".diff-counts")).toHaveCount(0);
    // the command still copies, and the extras still render under the message
    await expect(page.locator(".diff-cmd .install")).toHaveAttribute(
      "data-copy",
      "npx ymmv-cli@latest extrasonly vs blankslate",
    );
    await expect(page.locator(".diff-x-who")).toHaveText(["extrasonly"]);
    await expect(page.locator(".diff-x-row dd")).toHaveText("Corne v4");
  });

  test("omits the extras block entirely when neither side has extras", async ({ page }) => {
    await page.goto("/plainuser/vs/plainuser");
    await expect(page.locator(".diff-counts")).toContainText("0 differ");
    expect(await page.locator(".diff-extras").count()).toBe(0);
  });

  test("a self-diff lists each extra once, under the one handle", async ({ page }) => {
    // Both sides are the same profile: listing each side's extras would print every one twice.
    await page.goto("/antfu/vs/antfu");
    await expect(page.locator(".diff-x-who")).toHaveText(["antfu"]);
    const rows = page.locator(".diff-x-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "HHKB Pro 2" })).toHaveCount(1);
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

  test("302s a reserved viewer to the viewed profile: nobody can publish that name", async ({
    request,
  }) => {
    // isReserved lowercases, so /Login is reserved too. `404` is reserved with a live seed row.
    for (const viewer of ["login", "Login", "404"]) {
      const res = await request.get(`/antfu/vs/${viewer}`, { maxRedirects: 0 });
      expect(res.status(), viewer).toBe(302);
      expect(res.headers().location, viewer).toBe("/antfu");
      expect(res.headers()["cache-control"], viewer).toContain("s-maxage=10");
    }
    // A renamed viewed handle follows its rename first, then lands on the profile: two hops.
    const renamed = await request.get("/antfuold/vs/login", { maxRedirects: 0 });
    expect(renamed.status()).toBe(301);
    expect(renamed.headers().location).toBe("/antfu/vs/login");
    const landed = await request.get("/antfuold/vs/login");
    expect(landed.status()).toBe(200);
    expect(landed.url()).toMatch(/\/antfu$/);
  });

  test("a valid viewer with no profile still gets the nudge, not the reserved redirect", async ({
    page,
  }) => {
    const res = await page.goto("/antfu/vs/nobody");
    expect(res?.status()).toBe(200);
    expect(page.url()).toMatch(/\/antfu\/vs\/nobody$/);
    await expect(page.locator(".nudge")).toContainText("No ymmv profile for nobody yet.");
    // the nudge is the profile page: `antfu vs nobody` would fail, so no `vs` in its command
    await expect(page.locator(".view-cmd .install")).toHaveAttribute(
      "data-copy",
      "npx ymmv-cli@latest antfu",
    );
  });

  test("404s a diff against an unknown profile", async ({ page }) => {
    const res = await page.goto("/ghosthandle/vs/bardisty");
    expect(res?.status()).toBe(404);
    // A genuine miss keeps the short not-found TTL; only a thrown render is the no-store 500.
    expect(res?.headers()["cache-control"]).toContain("s-maxage=10");
    await expect(page.locator(".empty-msg")).toHaveText("no ymmv profile for ghosthandle yet.");
  });

  test("a diff whose render throws is a 500 no-store, never a cached 404", async ({ request }) => {
    // The seed stores corruptrow's editor as a BLOB, so diff() throws in the page frontmatter.
    // Astro's own error path rendered that as the /[handle] not-found page, cached for 10s.
    for (const path of ["/corruptrow/vs/antfu", "/antfu/vs/corruptrow"]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(500);
      expect(res.headers()["cache-control"], path).toBe("no-store");
      // The fixed error page: not a profile, not a not-found page, nothing of the error itself.
      const body = await res.text();
      expect(body, path).toContain("Server error. Try again in a moment.");
      expect(body, path).not.toMatch(/empty-msg|readout|toLowerCase/);
    }
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
    // it breaks only at its slashes (<wbr>s), and still reads, and copies, as one unbroken string
    expect(await link.evaluate((a) => a.textContent)).toBe(
      "github.com/antfu/dotfiles-but-with-a-very-long-path/blob/main/config",
    );
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

test.describe("bidi controls (Trojan-Source spoofing)", () => {
  // xsstest carries U+202E (RLO) in a shell entry, an extras label and an extras URL (seed.sql);
  // every HTML surface must strip it while the JSON API keeps the stored value verbatim.
  // innerText + regex: toContainText normalizes whitespace, not bidi controls.
  const BIDI = /\p{Bidi_Control}/u;
  const RLO_ENCODED = "%E2%80%AE"; // U+202E as a URL segment

  test("profile page strips controls from values, labels and link titles; href stays serialized", async ({
    page,
  }) => {
    await page.goto("/xsstest");
    const text = await page.locator(".profile").innerText();
    expect(text).not.toMatch(BIDI);
    expect(text).toContain("zshevil");
    expect(text).toContain("Bidilabel");
    // safeHref serializes through URL, so the control is percent-encoded in the href, and the
    // full-URL tooltip is stripped
    const link = page.locator(`a[href="https://github.com/${RLO_ENCODED}bidi"]`);
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText("github.com/bidi");
    await expect(link).toHaveAttribute("title", "https://github.com/bidi");
  });

  test("a non-link that starts with https:// keeps its scheme and is never an <a>", async ({
    page,
  }) => {
    await page.goto("/xsstest");
    const cell = page.locator(".profile :is(td, dd)").filter({ hasText: "https://evil com" });
    await expect(cell).toHaveCount(1);
    expect(await cell.locator("a").count()).toBe(0);
  });

  test("JSON API returns the stored value verbatim (never sanitized)", async ({ request }) => {
    const res = await request.get("/api/v1/u/xsstest");
    expect(res.status()).toBe(200);
    expect(await res.text()).toMatch(BIDI);
  });

  test("diff page strips controls from cells and extras", async ({ page }) => {
    await page.goto("/antfu/vs/xsstest");
    const diff = await page.locator("table.diff").innerText();
    expect(diff).not.toMatch(BIDI);
    const shell = page.locator("tr.d").filter({ hasText: "shell" });
    await expect(shell.locator(".mine")).toHaveText("zshevil");
    const extras = await page.locator(".diff-extras").innerText();
    expect(extras).not.toMatch(BIDI);
    expect(extras).toContain("Bidilabel");
    expect(extras).toContain("https://evil com");
  });

  test("404 page strips controls from the raw URL segment", async ({ page }) => {
    const res = await page.goto(`/${RLO_ENCODED}ghost`);
    expect(res?.status()).toBe(404);
    const h1 = await page.locator("h1.handle").innerText();
    expect(h1).toBe("ghost");
    const span = await page.locator(".empty-msg .h").innerText();
    expect(span).not.toMatch(BIDI);
    expect(span).toContain("ghost");
  });

  test("an all-control URL segment takes the generic 404 branch", async ({ page }) => {
    const res = await page.goto(`/${RLO_ENCODED}`);
    expect(res?.status()).toBe(404);
    await expect(page.locator("h1.handle")).toHaveText("404");
    await expect(page.locator(".empty-msg")).toHaveText("no page here.");
  });

  test("diff nudge strips controls from the viewer segment", async ({ page }) => {
    const res = await page.goto(`/antfu/vs/${RLO_ENCODED}ghost`);
    expect(res?.status()).toBe(200);
    const nudge = await page.locator(".nudge").innerText();
    expect(nudge).not.toMatch(BIDI);
    expect(nudge).toContain("ghost");
  });
});

test.describe("fonts (Astro Fonts API)", () => {
  test("self-hosts and preloads the two faces", async ({ page, request }) => {
    await page.goto("/antfu");

    // Exactly two preloads: Geist and Geist Mono, latin each. If a build-time provider fetch
    // degrades a family it emits zero faces and its preload vanishes, so this count is the
    // tripwire for a silent font-degradation build.
    const preloads = page.locator('link[rel="preload"][as="font"]');
    await expect(preloads).toHaveCount(2);
    const hrefs = await preloads.evaluateAll((ls) => ls.map((l) => l.getAttribute("href") ?? ""));
    expect(hrefs.every((h) => h.startsWith("/_astro/fonts/") && h.endsWith(".woff2"))).toBe(true);

    // The hashed woff2 actually serves, same-origin (no runtime third-party request).
    const font = await request.get(hrefs[0]);
    expect(font.status()).toBe(200);
    expect(font.headers()["content-type"]).toContain("font/woff2");

    // The Fonts API owns --font-sans/-mono; ymmv.css consumes them. Verify the real families
    // are wired (a renamed cssVariable or a dropped <Font> would break this).
    const vars = await page.evaluate(() => {
      const r = getComputedStyle(document.documentElement);
      return [r.getPropertyValue("--font-sans"), r.getPropertyValue("--font-mono")];
    });
    expect(vars[0]).toContain("Geist");
    expect(vars[0]).not.toContain("Geist Mono");
    expect(vars[1]).toContain("Geist Mono");
  });
});
