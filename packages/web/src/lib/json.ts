// The JSON reply for the bearer endpoints (auth/token, auth/logout, auth/whoami): a token-bearing
// or token-authed response must never be cached by any intermediary.
export function noStoreJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
