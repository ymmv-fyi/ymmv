// The JSON reply for the bearer endpoints (auth/token, auth/logout, auth/whoami, the own-profile
// read): a token-bearing or token-authed response must never be cached by any intermediary.
// `headers` adds to the fixed pair (an entity-tag, say); it cannot override them.
export function noStoreJson(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json", "cache-control": "no-store" },
  });
}
