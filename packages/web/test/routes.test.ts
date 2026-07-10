import { isReserved, isValidHandle } from "@ymmv/shared";
import { describe, expect, it } from "vitest";

// Every top-level STATIC route the web app serves itself must be a reserved handle.
//
//   src/pages/404.astro   → /404   ─┐ static: Astro resolves these ahead of
//   src/pages/api/…       → /api/… ─┘ the dynamic [handle] page
//   src/pages/[handle]/…  → /:handle  (dynamic — never a literal segment)
//   src/pages/index.astro → /         (root — not a handle)
//
// A handle-shaped static segment missing from RESERVED is claimable at publish, yet its
// HTML page is shadowed by the static route while the JSON endpoint still serves the
// profile — the two surfaces then disagree forever. That is exactly how `404` slipped in.
//
// import.meta.glob is resolved by Vite at transform time, so this reads the real route
// table without a filesystem (these tests run inside workerd). The loaders are never
// invoked; only the matched keys matter.
const PAGE_FILES = import.meta.glob("../src/pages/**/*");

/** The literal first path segment each page file contributes to the URL space. */
function topLevelSegments(paths: string[]): Set<string> {
  const segments = new Set<string>();
  for (const path of paths) {
    const rel = path.replace("../src/pages/", "");
    const slash = rel.indexOf("/");
    // Nested path → its directory name. Bare file → its basename with the page extension
    // stripped. Strip ANY trailing extension, not a fixed .astro/.ts allowlist: Astro also
    // serves .js/.md/.mdx pages, and an unstripped `status.js` would fail isValidHandle and
    // get skipped silently — the very blind spot this test exists to close.
    const first = slash === -1 ? rel.replace(/\.[^.]+$/, "") : rel.slice(0, slash);
    if (first === "index") continue; // the site root, not a handle
    segments.add(first);
  }
  return segments;
}

describe("reserved handles cover the static route table", () => {
  const segments = topLevelSegments(Object.keys(PAGE_FILES));

  // Anti-vacuity: a moved/renamed pages dir makes the glob match nothing, and every
  // assertion below would then pass while checking exactly zero routes.
  it("actually found the route table", () => {
    expect(Object.keys(PAGE_FILES).length).toBeGreaterThan(0);
    expect(segments).toContain("api");
    expect(segments).toContain("404");
  });

  it("reserves every static top-level route that could be claimed as a handle", () => {
    // A segment that cannot be a valid handle (`[handle]`, `robots.txt`) can never collide,
    // so it needs no reservation. Everything else must be reserved.
    const claimable = [...segments].filter((s) => isValidHandle(s));
    const unreserved = claimable.filter((s) => !isReserved(s));
    expect(unreserved).toEqual([]);
  });
});
