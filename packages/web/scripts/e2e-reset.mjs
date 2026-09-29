// e2e:serve's first step: wipe the local D1 state and the build, so every server starts from a
// fresh build, migrations and seed. On Windows a workerd left behind by an earlier `wrangler dev`
// can keep files under .wrangler/state open even after its port is free, and rmSync then dies with
// a bare EPERM/EBUSY that names neither the holder nor the fix.
import { rmSync } from "node:fs";

for (const dir of [".wrangler/state", "dist"]) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== "EPERM" && err.code !== "EBUSY") throw err;
    console.error(
      `e2e:serve: cannot remove ${dir} (${err.code}): another process still has it open, most ` +
        "likely a workerd.exe left by an earlier `wrangler dev` in this checkout. End that " +
        "process (its command line names this checkout's path; other checkouts' workerd " +
        "processes are not the cause), then rerun.",
    );
    process.exit(1);
  }
}
