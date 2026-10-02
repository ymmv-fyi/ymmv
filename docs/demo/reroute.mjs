// Loaded with `node --import` by the demo tape's ymmv(). The CLI makes every request with fetch and
// a string URL. Those to https://ymmv.fyi go to the local Worker record.sh started, so the gif shows
// the real address while nothing reaches it, and any other is refused. A redirect fails instead of
// being followed, since the hop wouldn't come back through here; the demo never meets one.

const SITE = "https://ymmv.fyi";
const worker = process.env.YMMV_DEMO_WORKER;
if (!worker) throw new Error("YMMV_DEMO_WORKER is not set. Record with `pnpm demo`.");
// The login record.sh made goes out with these requests, so they only ever go to this machine.
// The parsed hostname is compared, not a prefix: http://localhost.example starts with
// http://localhost. The origin alone is used, so a path or userinfo in the value changes nothing.
const { origin, hostname } = new URL(worker);
if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
  throw new Error(`demo: YMMV_DEMO_WORKER is ${worker}, not a loopback address`);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input);
  if (url !== SITE && !url.startsWith(`${SITE}/`)) {
    return Promise.reject(new Error(`demo: refused a request to ${url}`));
  }
  return realFetch(origin + url.slice(SITE.length), {
    ...init,
    redirect: init?.redirect ?? "error",
  });
};
