// Hermetic env for the CLI suite. These variables change module-load-time constants (config.ts
// bakes BASE at import) and live color/term decisions (colorEnabled(), link()'s TERM denylist),
// so a developer's ambient YMMV_API/FORCE_COLOR/NO_COLOR/TERM must never leak into assertions.
// Runs before each test file's module graph is imported (vitest setupFiles).
delete process.env.YMMV_API;
delete process.env.YMMV_TOKEN;
delete process.env.YMMV_HANDLE;
delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;
process.env.TERM = "xterm-256color";
// Suite-wide kill switch for the startup update check: main()-driven tests and the spawned
// dist/cli.js in bin-entry.test.ts must never hit the npm registry (dev builds are 0.0.0 and
// would self-skip anyway — this makes hermeticity explicit instead of incidental). update-check's
// own tests pass `env` per-call, so the switch never reaches them. NO_UPDATE_NOTIFIER is the
// ecosystem-standard opt-out honored alongside YMMV_NO_UPDATE_CHECK; clear any ambient value.
process.env.YMMV_NO_UPDATE_CHECK = "1";
delete process.env.NO_UPDATE_NOTIFIER;
