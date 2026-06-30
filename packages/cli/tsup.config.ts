import { defineConfig } from "tsup";

// The CLI publishes to npm as a self-contained tarball. `@ymmv/shared` is a PRIVATE workspace
// package (never published), so it MUST be inlined or `npx ymmv-cli` fails to resolve it on a user's
// machine. tsup (esbuild) bundles it in; real published deps (env-paths) stay external and are
// installed from the package.json `dependencies`. tsup preserves the entry's `#!/usr/bin/env node`
// shebang and marks the output executable.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  noExternal: ["@ymmv/shared"],
  // No .d.ts / sourcemaps: this is an executable, not a library.
  dts: false,
  sourcemap: false,
});
