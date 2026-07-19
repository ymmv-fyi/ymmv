import {
  CLI_VERBS,
  CURATED_KEYS,
  type CuratedKey,
  isCuratedKey,
  isReserved,
  isValidHandle,
  MAX_LABEL,
  MAX_VALUE,
} from "@ymmv/shared";
import { sanitizeValue } from "./render.js";

// Argument resolution. The bare `ymmv <handle>` form stays primary, the verb words
// (login/logout/set/unset/delete/view/help/publish/version) dispatch as verbs, and
// `ymmv view <handle>` is the explicit alias for viewing (every verb word is also a reserved
// handle, so a verb-colliding profile cannot exist — both view paths reject reserved names
// locally rather than making a round-trip that misreports "no profile yet"). Verbs reject
// unexpected trailing tokens instead of dropping them — `ymmv -y delete` must never read as a
// consented publish, and `ymmv delete oldname -y` must never read as a consented delete
// (help is the one deliberate exception, see below). Pure + total: every argv maps to exactly
// one Command (including `error`), so dispatch in index.ts is a flat switch and the whole table
// is unit-testable without any IO.

/** What `ymmv set` targets — a curated key/value or a free-form extra. */
export type SetTarget =
  | { kind: "curated"; key: CuratedKey; value: string }
  | { kind: "extra"; label: string; value: string };

/** What `ymmv unset` targets — a curated key or a free-form extra's label. */
export type UnsetTarget = { kind: "curated"; key: CuratedKey } | { kind: "extra"; label: string };

export type Command =
  | { kind: "publish"; yes: boolean }
  | { kind: "view"; handle: string }
  | { kind: "login" }
  | { kind: "logout" }
  | { kind: "set"; target: SetTarget }
  | { kind: "unset"; target: UnsetTarget }
  | { kind: "delete"; yes: boolean }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

// The --extra invocation shapes, written once — usage strings and error hints compose from these.
const SET_EXTRA = 'ymmv set --extra "Label=Value"';
const UNSET_EXTRA = 'ymmv unset --extra "Label"';
const SET_USAGE = `usage: ymmv set <key> <value>  |  ${SET_EXTRA}`;
const EXTRA_USAGE = `usage: ${SET_EXTRA}`;
const UNSET_USAGE = `usage: ymmv unset <key>  |  ${UNSET_EXTRA}`;
const VIEW_USAGE = "usage: ymmv view <handle>";

/** One source of truth for the not-a-curated-key error; each verb supplies its own extras hint.
 *  `head` is raw argv, so strip escapes before echoing (same rule as the handle branches). */
function invalidKeyError(head: string, hint: string): Command {
  return {
    kind: "error",
    message:
      `"${sanitizeValue(head)}" is not a curated key. Valid keys: ${CURATED_KEYS.join(", ")}.\n` +
      `For anything else, use: ${hint}.`,
  };
}

/** Verbs that take nothing: any trailing token is a usage error, never silently dropped. */
function noArgs(verb: "login" | "logout", rest: string[]): Command {
  return rest.length === 0 ? { kind: verb } : { kind: "error", message: `usage: ymmv ${verb}` };
}

/** Verbs whose only extra token may be -y/--yes — consent stays scoped to this one command,
 *  so `delete oldname -y` and `delete -y -y` are errors, never a consented delete. */
function yesOnly(usage: string, rest: string[], make: (yes: boolean) => Command): Command {
  if (rest.length === 0) return make(false);
  if (rest.length === 1 && (rest[0] === "-y" || rest[0] === "--yes")) return make(true);
  return { kind: "error", message: usage };
}

// Pre-flight the shared write caps at the argv boundary: the server would 422 these anyway, but
// failing locally costs no round trip and no login. Echo LENGTHS only, never the over-long value
// itself — the sanitize-every-argv-echo rule holds by construction when nothing is echoed.
function labelCapError(label: string): Command {
  return {
    kind: "error",
    message: `That label is ${label.length} characters; the cap is ${MAX_LABEL}.`,
  };
}
function valueCapError(value: string): Command {
  return {
    kind: "error",
    message: `That value is ${value.length} characters; the cap is ${MAX_VALUE}.`,
  };
}

function parseSet(rest: string[]): Command {
  const head = rest[0];
  if (head === "--extra" || head === "-e") {
    // Everything after --extra is the "Label=Value" spec (joined so unquoted spaces survive).
    const spec = rest.slice(1).join(" ").trim();
    const eq = spec.indexOf("=");
    if (eq <= 0) return { kind: "error", message: EXTRA_USAGE };
    const label = spec.slice(0, eq).trim();
    const value = spec.slice(eq + 1).trim();
    if (!label || !value) return { kind: "error", message: EXTRA_USAGE };
    // A lone "-" means clear, same as the interactive publish prompt (a literal "-" value is
    // deliberately unrepresentable — that's the footgun this rewrite removes).
    if (value === "-") return { kind: "unset", target: { kind: "extra", label } };
    if (label.length > MAX_LABEL) return labelCapError(label);
    if (value.length > MAX_VALUE) return valueCapError(value);
    return { kind: "set", target: { kind: "extra", label, value } };
  }
  if (!head) return { kind: "error", message: SET_USAGE };
  if (!isCuratedKey(head)) return invalidKeyError(head, SET_EXTRA);
  const value = rest.slice(1).join(" ").trim();
  if (!value) return { kind: "error", message: `usage: ymmv set ${head} <value>` };
  // Same "-" clears convention as promptEntries; only an exactly-"-" trimmed value triggers it,
  // so multi-token values like "- foo" or "Fira-Code" stay literal sets.
  if (value === "-") return { kind: "unset", target: { kind: "curated", key: head } };
  if (value.length > MAX_VALUE) return valueCapError(value);
  return { kind: "set", target: { kind: "curated", key: head, value } };
}

function parseUnset(rest: string[]): Command {
  const head = rest[0];
  if (head === "--extra" || head === "-e") {
    // Everything after --extra is the label (joined so unquoted spaces survive, like parseSet).
    const label = rest.slice(1).join(" ").trim();
    if (!label) return { kind: "error", message: `usage: ${UNSET_EXTRA}` };
    // CLI-set labels can never contain "=" (parseSet splits on the first one), so this is
    // muscle-memory "Label=Value" — point at the label-only form instead of silently no-op'ing.
    if (label.includes("=")) {
      return {
        kind: "error",
        message: 'unset takes just the label: ymmv unset --extra "Keyboard"',
      };
    }
    return { kind: "unset", target: { kind: "extra", label } };
  }
  if (!head) return { kind: "error", message: UNSET_USAGE };
  if (!isCuratedKey(head)) return invalidKeyError(head, UNSET_EXTRA);
  // A trailing value almost certainly means the user meant `set`; silently unsetting would be a
  // destructive surprise.
  if (rest.length > 1) return { kind: "error", message: `usage: ymmv unset ${head}` };
  return { kind: "unset", target: { kind: "curated", key: head } };
}

export function resolveArg(argv: string[]): Command {
  const first = argv[0];
  const rest = argv.slice(1);

  // Global help/version. Help deliberately ignores trailing tokens: printing help is harmless
  // by construction, and a future git-style `ymmv help <command>` must stay non-breaking.
  // Version is strict like every other verb.
  if (first === "-h" || first === "--help" || first === "help") return { kind: "help" };
  if (first === "-V" || first === "-v" || first === "--version" || first === "version") {
    return rest.length === 0
      ? { kind: "version" }
      : { kind: "error", message: "usage: ymmv version" };
  }

  // Bare `ymmv` (optionally `-y`) → publish, the default magic. A flag-first tail is refused:
  // the -y consent was given for whatever follows (`ymmv -y delete`), not for a publish.
  if (first === undefined) return { kind: "publish", yes: false };
  if (first === "-y" || first === "--yes") {
    if (rest.length > 0) {
      // Echo the user's own intent when it's a yes-accepting verb; never advertise the
      // destructive delete form to someone who typed something else.
      const example = rest[0] === "delete" || rest[0] === "publish" ? rest[0] : "publish";
      return {
        kind: "error",
        message: `Put ${first} after the command: ymmv ${example} -y. A bare ymmv -y publishes without prompts.`,
      };
    }
    return { kind: "publish", yes: true };
  }

  // Reserved verbs.
  if (first === "login" || first === "logout") return noArgs(first, rest);
  if (first === "publish") {
    return yesOnly("usage: ymmv publish [-y]", rest, (yes) => ({ kind: "publish", yes }));
  }
  if (first === "delete") {
    return yesOnly(
      "usage: ymmv delete [-y] (deletes your own profile; takes no handle)",
      rest,
      (yes) => ({ kind: "delete", yes }),
    );
  }
  if (first === "set") return parseSet(rest);
  if (first === "unset") return parseUnset(rest);
  if (first === "view") {
    const handle = rest[0];
    if (!handle) return { kind: "error", message: VIEW_USAGE };
    if (!isValidHandle(handle)) {
      // Rejection paths echo UNVALIDATED argv (here, the bare branch, unknown-option,
      // invalidKeyError) — every one strips escapes before printing.
      return { kind: "error", message: `"${sanitizeValue(handle)}" is not a valid GitHub handle.` };
    }
    if (isReserved(handle)) return reservedError(handle);
    if (rest.length > 1) return { kind: "error", message: VIEW_USAGE };
    return { kind: "view", handle };
  }

  // Anything else: an unknown flag is an error; otherwise it's a bare handle to view. Reserved
  // is checked before the trailing guard so `ymmv Set editor vim` hints the verb, not the tail.
  if (first.startsWith("-")) {
    return {
      kind: "error",
      message: `Unknown option "${sanitizeValue(first)}". Run \`ymmv help\`.`,
    };
  }
  if (!isValidHandle(first)) {
    // Same unvalidated-argv echo as the view branch: sanitize before printing.
    return {
      kind: "error",
      message: `"${sanitizeValue(first)}" is not a valid GitHub handle. Run \`ymmv help\`.`,
    };
  }
  if (isReserved(first)) return reservedError(first, true);
  if (rest.length > 0) {
    return { kind: "error", message: `Unexpected arguments after "${first}". Run \`ymmv help\`.` };
  }
  return { kind: "view", handle: first };
}

/** Shape-check first, reserved second: only handle-shaped input reaches this hint. The reserved
 *  list is baked into each released CLI (a fast local answer instead of a round-trip that
 *  misreports "no profile yet"); the API stays the trust boundary. NOTE: removing a name from
 *  RESERVED_SET is a breaking change for shipped CLIs — they would keep refusing it locally.
 *  On the bare path (`hintVerbs`), a capitalized verb (`ymmv Set`) almost certainly meant the
 *  command, so the error points at it; the view path stays hint-free (the user asked to view). */
function reservedError(handle: string, hintVerbs = false): Command {
  const verb = handle.toLowerCase();
  const hint =
    hintVerbs && (CLI_VERBS as readonly string[]).includes(verb)
      ? ` Did you mean: ymmv ${verb}?`
      : "";
  return {
    kind: "error",
    message: `"${handle}" is a reserved name; it can't have a profile.${hint}`,
  };
}
