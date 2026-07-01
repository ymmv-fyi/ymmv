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

  test("a 1-key edge profile still renders a spec table (no awkward empty block)", async ({
    page,
  }) => {
    // xsstest has one curated entry (dotfiles) + extras — the table must still render.
    await page.goto("/xsstest");
    await expect(page.locator("table.spec").first()).toBeVisible();
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
  });
});

test.describe("the 3-column diff", () => {
  test("counts differences and spends amber only on real differences", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/antfu/vs/bardisty");
    await expect(page.locator(".foot")).toContainText("6 differ · 4 shared");

    const changedYours = page.locator("tr.changed .yours").first();
    const sameYours = page.locator("tr.same .yours").first();
    const changedColor = await changedYours.evaluate((el) => getComputedStyle(el).color);
    const sameColor = await sameYours.evaluate((el) => getComputedStyle(el).color);
    expect(changedColor).toBe("rgb(232, 163, 61)"); // amber on a difference
    expect(sameColor).not.toBe(changedColor); // same rows recede — never amber
  });

  test("nudges to publish when the viewer has no profile", async ({ page }) => {
    await page.goto("/antfu/vs/ghostviewer");
    await expect(page.locator(".nudge")).toContainText("publish yours to diff");
    await expect(page.locator("h1.handle")).toContainText("antfu"); // still shows the viewed profile
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
    await expect(
      page.getByRole("link", { name: /dotfiles-but-with-a-very-long-path/ }),
    ).toBeVisible();
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
