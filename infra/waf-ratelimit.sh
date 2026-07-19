#!/usr/bin/env bash
# Provision or verify the ymmv.fyi WAF rate-limiting rule (zone phase http_ratelimit).
# This is the EDGE half of the rate-limit story; the Workers-binding half (RL_WRITE/RL_AUTH)
# lives in packages/web/wrangler.jsonc + packages/web/src/lib/rate-limit.ts.
#
# Usage:
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=... ./infra/waf-ratelimit.sh verify
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=... ./infra/waf-ratelimit.sh apply
#
#   verify   read-only: print the live rule and compare it to this file's constants.
#            exit 0 = matches, 1 = drifts (or is ambiguous), 2 = absent.
#   apply    create-or-update the rule to match this file. Idempotent; safe to re-run.
#
# Env (never committed): CLOUDFLARE_API_TOKEN (zone WAF read for verify, edit for apply),
# CLOUDFLARE_ZONE_ID (the ymmv.fyi zone). Requires curl + jq. Exit 4 = API/transport failure.
#
# Blast-radius rules baked into `apply`:
#   - PUT on the phase entrypoint REPLACES every rule in the phase, so PUT is used ONLY when the
#     zone provably has no http_ratelimit entrypoint: the entrypoint GET must answer HTTP 404.
#     Any OTHER failure (401/403/5xx/transport) ABORTS — a blip must never read as "phase empty".
#     An existing entrypoint gets POST .../rules (append) or PATCH .../rules/<id> (update) with
#     the FULL rule body.
#   - Every mutation requires HTTP 2xx AND `success:true`; the API's errors array is printed on
#     failure (Cloudflare can answer 200 with success:false).
#   - Matching is by description first, expression second. Multiple matches are a hard error
#     (never guess which rule to overwrite).
#   - Single operator assumed: Cloudflare discourages concurrent mutations of one ruleset, so
#     don't run `apply` from two places at once (two racing applies can double-POST the rule,
#     which then errors as ambiguous until one copy is deleted by hand).
set -euo pipefail

# ---- The rule (transcribed from the live zone entrypoint, read-only verified 2026-07-19) ----
RULE_DESCRIPTION="ymmv: rate-limit profile + auth writes per IP"
RULE_ACTION="block"
RULE_EXPRESSION='(http.request.method in {"POST" "DELETE"} and (starts_with(http.request.uri.path, "/api/v1/profile") or starts_with(http.request.uri.path, "/api/v1/auth")))'
# Per IP per colo: 30 requests / 10s, then block for 10s. Complements the Workers bindings
# declared in wrangler.jsonc (per-identity writes + per-IP mint): this rule is the volumetric
# shield in front of them, and the only edge cover for endpoints with no binding (logout).
RL_CHARACTERISTICS='["ip.src","cf.colo.id"]'
RL_PERIOD=10
RL_REQUESTS_PER_PERIOD=30
RL_MITIGATION_TIMEOUT=10
# ---------------------------------------------------------------------------------------------

API="https://api.cloudflare.com/client/v4"

command -v curl >/dev/null 2>&1 || { echo "error: curl is required" >&2; exit 3; }
command -v jq >/dev/null 2>&1 || { echo "error: jq is required (https://jqlang.org)" >&2; exit 3; }
: "${CLOUDFLARE_API_TOKEN:?error: set CLOUDFLARE_API_TOKEN (zone WAF read for verify, edit for apply)}"
: "${CLOUDFLARE_ZONE_ID:?error: set CLOUDFLARE_ZONE_ID (the ymmv.fyi zone)}"

# METHOD PATH [JSON_BODY] -> fills API_STATUS (HTTP code) + API_BODY (response text).
# No -f: non-2xx statuses are DATA here (404 means "no entrypoint"), branched on by callers.
# The bearer travels via a curl config on stdin, not argv, so the token never appears in the
# process listing. A transport-level failure (DNS, TLS, timeout) aborts.
API_STATUS=""
API_BODY=""
api_call() {
  local method=$1 path=$2 body=${3:-} out
  local args=(-sS -X "$method" --url "$API$path" -w $'\n%{http_code}' -K -)
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" --data "$body")
  fi
  out=$(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" \
    | curl "${args[@]}") || {
    echo "error: transport failure on $method $path" >&2
    exit 4
  }
  API_STATUS=${out##*$'\n'}
  API_BODY=${out%$'\n'*}
}

# CONTEXT. Dies (exit 4) unless the last api_call answered 2xx with success:true, printing the
# API's errors array — `| jq -r '.success'` alone would let a failed mutation exit 0.
require_success() {
  if [ "${API_STATUS:0:1}" = "2" ] && jq -e '.success == true' >/dev/null 2>&1 <<<"$API_BODY"; then
    return 0
  fi
  echo "error: $1 failed (HTTP $API_STATUS)" >&2
  jq -r '.errors // [] | .[] | "  [\(.code)] \(.message)"' <<<"$API_BODY" >&2 2>/dev/null || true
  exit 4
}

# The declared rule object (also the FULL body PATCH sends: partial PATCHes drop fields).
declared_rule() {
  jq -n \
    --arg desc "$RULE_DESCRIPTION" \
    --arg action "$RULE_ACTION" \
    --arg expr "$RULE_EXPRESSION" \
    --argjson chars "$RL_CHARACTERISTICS" \
    --argjson period "$RL_PERIOD" \
    --argjson rpp "$RL_REQUESTS_PER_PERIOD" \
    --argjson mt "$RL_MITIGATION_TIMEOUT" \
    '{description: $desc, action: $action, expression: $expr, enabled: true,
      ratelimit: {characteristics: $chars, period: $period,
                  requests_per_period: $rpp, mitigation_timeout: $mt}}'
}

# Fills ENTRYPOINT_PRESENT (1/0) + API_BODY. ONLY HTTP 404 means "no entrypoint yet"; any other
# non-200 aborts, so a blip can never masquerade as an empty phase (see blast-radius rules).
ENTRYPOINT_PRESENT=0
fetch_entrypoint() {
  api_call GET "/zones/$CLOUDFLARE_ZONE_ID/rulesets/phases/http_ratelimit/entrypoint"
  case "$API_STATUS" in
    200)
      require_success "entrypoint read"
      ENTRYPOINT_PRESENT=1
      ;;
    404)
      ENTRYPOINT_PRESENT=0
      ;;
    *)
      require_success "entrypoint read" # non-2xx: prints the errors array and exits 4
      ;;
  esac
}

# stdin: entrypoint JSON. stdout: the rules matching ours (description first, expression fallback).
matching_rules() {
  jq --arg desc "$RULE_DESCRIPTION" --arg expr "$RULE_EXPRESSION" \
    '[.result.rules // [] | .[] | select(.description == $desc or .expression == $expr)]'
}

# $1: one live rule (JSON). Succeeds iff every declared field matches it.
rule_matches_declared() {
  jq -e \
    --arg desc "$RULE_DESCRIPTION" \
    --arg action "$RULE_ACTION" \
    --arg expr "$RULE_EXPRESSION" \
    --argjson chars "$RL_CHARACTERISTICS" \
    --argjson period "$RL_PERIOD" \
    --argjson rpp "$RL_REQUESTS_PER_PERIOD" \
    --argjson mt "$RL_MITIGATION_TIMEOUT" \
    '.description == $desc and .action == $action and .expression == $expr and .enabled == true
     and ((.ratelimit.characteristics // []) | sort) == ($chars | sort)
     and .ratelimit.period == $period
     and .ratelimit.requests_per_period == $rpp
     and .ratelimit.mitigation_timeout == $mt' >/dev/null <<<"$1"
}

do_verify() {
  local matches count live
  fetch_entrypoint
  if [ "$ENTRYPOINT_PRESENT" -eq 0 ]; then
    echo "absent: the zone has no http_ratelimit entrypoint ruleset"
    exit 2
  fi
  matches=$(matching_rules <<<"$API_BODY")
  count=$(jq 'length' <<<"$matches")
  if [ "$count" -eq 0 ]; then
    echo "absent: no rule matches description or expression"
    exit 2
  fi
  if [ "$count" -gt 1 ]; then
    echo "ambiguous: $count rules match; ids:" >&2
    jq -r '.[].id' <<<"$matches" >&2
    exit 1
  fi
  live=$(jq '.[0]' <<<"$matches")
  echo "live rule:"
  jq . <<<"$live"
  if rule_matches_declared "$live"; then
    echo "verify: OK (live rule matches this file)"
    exit 0
  fi
  echo "verify: DRIFT (live rule differs from this file's constants)" >&2
  echo "declared:" >&2
  declared_rule >&2
  exit 1
}

do_apply() {
  local rule ruleset_id matches count live rule_id
  rule=$(declared_rule)
  fetch_entrypoint
  if [ "$ENTRYPOINT_PRESENT" -eq 0 ]; then
    # Provably no entrypoint (the GET answered 404): PUT creates it. This is the ONLY case PUT
    # is safe (it replaces the whole phase; here the phase is empty).
    echo "creating http_ratelimit entrypoint with the rule"
    api_call PUT "/zones/$CLOUDFLARE_ZONE_ID/rulesets/phases/http_ratelimit/entrypoint" \
      "$(jq -n --argjson r "$rule" '{rules: [$r]}')"
    require_success "entrypoint create (PUT)"
    echo "apply: OK"
    return
  fi
  ruleset_id=$(jq -r '.result.id // empty' <<<"$API_BODY")
  if [ -z "$ruleset_id" ]; then
    echo "error: entrypoint response carried no ruleset id; refusing to mutate blind" >&2
    exit 4
  fi
  matches=$(matching_rules <<<"$API_BODY")
  count=$(jq 'length' <<<"$matches")
  if [ "$count" -gt 1 ]; then
    echo "error: $count rules match description or expression; refusing to guess. ids:" >&2
    jq -r '.[].id' <<<"$matches" >&2
    exit 1
  fi
  if [ "$count" -eq 0 ]; then
    echo "adding the rule to ruleset $ruleset_id"
    api_call POST "/zones/$CLOUDFLARE_ZONE_ID/rulesets/$ruleset_id/rules" "$rule"
    require_success "rule add (POST)"
    echo "apply: OK"
    return
  fi
  live=$(jq '.[0]' <<<"$matches")
  if rule_matches_declared "$live"; then
    echo "apply: already converged (nothing to do)"
    return
  fi
  rule_id=$(jq -r '.id // empty' <<<"$live")
  if [ -z "$rule_id" ]; then
    echo "error: matched rule carried no id; refusing to mutate blind" >&2
    exit 4
  fi
  echo "updating rule $rule_id in ruleset $ruleset_id"
  api_call PATCH "/zones/$CLOUDFLARE_ZONE_ID/rulesets/$ruleset_id/rules/$rule_id" "$rule"
  require_success "rule update (PATCH)"
  echo "apply: OK"
}

case "${1:-}" in
  verify) do_verify ;;
  apply) do_apply ;;
  *)
    echo "usage: $0 verify|apply" >&2
    exit 3
    ;;
esac
