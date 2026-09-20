import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addDismissals,
  type Dismissal,
  dismissalsPath,
  isDismissed,
  readDismissals,
  writeDismissals,
} from "../src/dismissals.js";
import { updateCachePath } from "../src/update-check.js";

const ESC = String.fromCharCode(27);
const ZED: Dismissal = { key: "editor", saved: "Zed", detected: "Neovim" };

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ymmv-dismissals-"));
  path = join(dir, "dismissed-marks.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("dismissalsPath", () => {
  it("sits next to the update cache (and so next to token.json)", () => {
    expect(dirname(dismissalsPath())).toBe(dirname(updateCachePath()));
    expect(basename(dismissalsPath())).toBe("dismissed-marks.json");
  });
});

describe("isDismissed", () => {
  it("matches only the exact disagreement: key, saved value, and detected value", () => {
    expect(isDismissed([ZED], "editor", "Zed", "Neovim")).toBe(true);
    expect(isDismissed([ZED], "editor", "Zed", "Helix")).toBe(false); // the detection changed
    expect(isDismissed([ZED], "editor", "Emacs", "Neovim")).toBe(false); // the saved value changed
    expect(isDismissed([ZED], "terminal", "Zed", "Neovim")).toBe(false);
    expect(isDismissed([], "editor", "Zed", "Neovim")).toBe(false);
  });

  it("compares like the marks do: a respelling of the same tool is the same disagreement", () => {
    expect(isDismissed([ZED], "editor", "zed", "nvim")).toBe(true);
    expect(isDismissed([ZED], "editor", ` Zed${ESC}[0m `, "Neovim")).toBe(true);
  });
});

describe("readDismissals / writeDismissals", () => {
  it("round-trips, creating the directory when it is missing", async () => {
    const nested = join(dir, "not", "yet", "dismissed-marks.json");
    const list: Dismissal[] = [ZED, { key: "terminal", saved: "WezTerm", detected: "VS Code" }];
    await writeDismissals(nested, list);
    expect(await readDismissals(nested)).toEqual(list);
  });

  it("a missing, unparseable, or wrong-shaped file reads as nothing dismissed", async () => {
    expect(await readDismissals(path)).toEqual([]);
    for (const body of ["{ not json", "null", "[]", "{}", '{"dismissed":"x"}']) {
      await writeFile(path, body);
      expect(await readDismissals(path)).toEqual([]);
    }
  });

  it("never opens a non-regular or oversized file: both read as nothing dismissed", async () => {
    await mkdir(path); // a directory where the file should be
    expect(await readDismissals(path)).toEqual([]);
    const big = join(dir, "big.json");
    await writeFile(big, JSON.stringify({ dismissed: [ZED], pad: "x".repeat(256 * 1024) }));
    expect(await readDismissals(big)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "is private like token.json: a 0700 dir when it creates one, a 0600 file",
    async () => {
      const nested = join(dir, "cfg", "dismissed-marks.json");
      await writeDismissals(nested, [ZED]);
      expect((await stat(dirname(nested))).mode & 0o777).toBe(0o700);
      expect((await stat(nested)).mode & 0o777).toBe(0o600);
    },
  );

  it("drops a malformed entry alone, and never carries stray fields along", async () => {
    await writeFile(
      path,
      JSON.stringify({
        dismissed: [
          { ...ZED, extra: "rides along?" },
          { key: "not-a-key", saved: "a", detected: "b" },
          { key: "editor", saved: "", detected: "b" },
          { key: "editor", saved: "a", detected: "x".repeat(300) },
          { key: "editor", saved: 1, detected: "b" },
          null,
          "editor",
        ],
      }),
    );
    expect(await readDismissals(path)).toEqual([ZED]);
  });

  it("writes each disagreement once and keeps the newest 64", async () => {
    await writeDismissals(path, [ZED, { ...ZED, saved: "zed", detected: "nvim" }]);
    expect(await readDismissals(path)).toEqual([ZED]);

    const many: Dismissal[] = Array.from({ length: 70 }, (_, i) => ({
      key: "font",
      saved: "Berkeley Mono",
      detected: `Font ${i}`,
    }));
    await writeDismissals(path, many);
    const back = await readDismissals(path);
    expect(back.length).toBe(64);
    expect(back[0]?.detected).toBe("Font 6");
    expect(back.at(-1)?.detected).toBe("Font 69");
  });

  it("reads back the largest history it can write: 64 entries of full-length non-ASCII values", async () => {
    // MAX_VALUE counts UTF-16 units; a lone surrogate is one unit and six bytes once escaped.
    const lone = String.fromCharCode(0xd800);
    const full: Dismissal[] = Array.from({ length: 64 }, (_, i) => ({
      key: "font",
      saved: lone.repeat(256),
      detected: `${i}`.padEnd(256, lone),
    }));
    await writeDismissals(path, full);
    expect((await stat(path)).size).toBeGreaterThan(64 * 1024);
    expect((await readDismissals(path)).length).toBe(64);
  });

  it("caps a file something else wrote, keeping the newest", async () => {
    const dismissed = Array.from({ length: 200 }, (_, i) => ({
      key: "font",
      saved: "Berkeley Mono",
      detected: `Font ${i}`,
    }));
    await writeFile(path, JSON.stringify({ dismissed }));
    const back = await readDismissals(path);
    expect(back.length).toBe(64);
    expect(back.at(-1)?.detected).toBe("Font 199");
  });

  describe("addDismissals", () => {
    const WEZ: Dismissal = { key: "terminal", saved: "WezTerm", detected: "VS Code" };

    it("adds to what the file holds now, including what another run wrote since this one read", async () => {
      await addDismissals(path, [ZED]); // no file yet
      await writeDismissals(path, [ZED, WEZ]); // another ymmv writes in between
      const FISH: Dismissal = { key: "shell", saved: "zsh", detected: "fish" };
      await addDismissals(path, [FISH]);
      expect(await readDismissals(path)).toEqual([ZED, WEZ, FISH]);
    });

    it("does not bring back what another run reset in between", async () => {
      await writeDismissals(path, [ZED]);
      await writeDismissals(path, []); // ymmv --reset-marks elsewhere
      await addDismissals(path, [WEZ]);
      expect(await readDismissals(path)).toEqual([WEZ]);
    });

    it("replaces an unparseable file, but leaves alone one it could not read", async () => {
      await writeFile(path, "{ not json");
      await addDismissals(path, [ZED]);
      expect(await readDismissals(path)).toEqual([ZED]);

      const unread = JSON.stringify({ dismissed: [WEZ], pad: "x".repeat(256 * 1024) });
      await writeFile(path, unread); // over the read bound: a history this run never saw
      await addDismissals(path, [ZED]);
      expect(await readFile(path, "utf8")).toBe(unread);
    });
  });

  it("an empty list empties the file (what --reset-marks writes)", async () => {
    await writeDismissals(path, [ZED]);
    await writeDismissals(path, []);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ dismissed: [] });
  });

  it("a failed write is swallowed and leaves no temp file behind", async () => {
    await writeFile(join(dir, "blocker"), "");
    await expect(
      writeDismissals(join(dir, "blocker", "dismissed-marks.json"), [ZED]),
    ).resolves.toBeUndefined();
    // rename onto a directory fails after the temp file was written: the temp must be removed.
    const asDir = join(dir, "taken");
    await writeDismissals(join(asDir, "child.json"), []); // creates `taken/`
    await expect(writeDismissals(asDir, [ZED])).resolves.toBeUndefined();
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
