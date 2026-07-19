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
