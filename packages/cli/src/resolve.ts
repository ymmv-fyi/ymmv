import {
  CURATED_KEYS,
  type CuratedKey,
  isCuratedKey,
  isReserved,
  isValidHandle,
} from "@ymmv/shared";

// Argument resolution. The bare `ymmv <handle>` form stays primary, the seven verb words
// (login/logout/set/unset/delete/view/help) dispatch as verbs, and `ymmv view <handle>` is the
// explicit alias for viewing (every verb word is also a reserved handle, so a verb-colliding
// profile cannot exist — both view paths reject reserved names locally rather than making a
// round-trip that misreports "no profile yet"). Pure + total: every argv maps to exactly one
// Command (including `error`), so dispatch in index.ts is a flat switch and the whole table is
// unit-testable without any IO.

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

/** One source of truth for the not-a-curated-key error; each verb supplies its own extras hint. */
function invalidKeyError(head: string, hint: string): Command {
  return {
    kind: "error",
    message:
      `"${head}" is not a curated key. Valid keys: ${CURATED_KEYS.join(", ")}.\n` +
      `For anything else, use: ${hint}.`,
  };
}

function hasYes(args: string[]): boolean {
  return args.includes("-y") || args.includes("--yes");
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
    return { kind: "set", target: { kind: "extra", label, value } };
  }
  if (!head) return { kind: "error", message: SET_USAGE };
  if (!isCuratedKey(head)) return invalidKeyError(head, SET_EXTRA);
  const value = rest.slice(1).join(" ").trim();
  if (!value) return { kind: "error", message: `usage: ymmv set ${head} <value>` };
  // Same "-" clears convention as promptEntries; only an exactly-"-" trimmed value triggers it,
  // so multi-token values like "- foo" or "Fira-Code" stay literal sets.
  if (value === "-") return { kind: "unset", target: { kind: "curated", key: head } };
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

  // Global help/version flags.
  if (first === "-h" || first === "--help" || first === "help") return { kind: "help" };
  if (first === "-V" || first === "-v" || first === "--version") return { kind: "version" };

  // Bare `ymmv` (optionally `-y`) → publish, the default magic.
  if (first === undefined) return { kind: "publish", yes: false };
  if (first === "-y" || first === "--yes") return { kind: "publish", yes: true };

  // Reserved verbs.
  if (first === "login") return { kind: "login" };
  if (first === "logout") return { kind: "logout" };
  if (first === "delete") return { kind: "delete", yes: hasYes(argv.slice(1)) };
  if (first === "set") return parseSet(argv.slice(1));
  if (first === "unset") return parseUnset(argv.slice(1));
  if (first === "view") {
    const handle = argv[1];
    if (!handle) return { kind: "error", message: "usage: ymmv view <handle>" };
    if (!isValidHandle(handle)) {
      return { kind: "error", message: `"${handle}" is not a valid GitHub handle.` };
    }
    if (isReserved(handle)) return reservedError(handle);
    return { kind: "view", handle };
  }

  // Anything else: an unknown flag is an error; otherwise it's a bare handle to view.
  if (first.startsWith("-")) {
    return { kind: "error", message: `Unknown option "${first}". Run \`ymmv help\`.` };
  }
  if (!isValidHandle(first)) {
    return {
      kind: "error",
      message: `"${first}" is not a valid GitHub handle. Run \`ymmv help\`.`,
    };
  }
  if (isReserved(first)) return reservedError(first);
  return { kind: "view", handle: first };
}

/** Shape-check first, reserved second: only handle-shaped input reaches this hint. The reserved
 *  list is baked into each released CLI (a fast local answer instead of a round-trip that
 *  misreports "no profile yet"); the API stays the trust boundary. NOTE: removing a name from
 *  RESERVED_SET is a breaking change for shipped CLIs — they would keep refusing it locally. */
function reservedError(handle: string): Command {
  return {
    kind: "error",
    message: `"${handle}" is a reserved name; it can't have a profile.`,
  };
}
