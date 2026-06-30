import { CURATED_KEYS, type CuratedKey, isCuratedKey, isValidHandle } from "@ymmv/shared";

// Argument resolution. The bare `ymmv <handle>` form stays primary, the six verb words
// (login/logout/set/delete/view/help) dispatch as verbs, and `ymmv view <handle>` is the explicit
// escape hatch. Pure + total: every argv maps to exactly one Command (including `error`), so
// dispatch in index.ts is a flat switch and the whole table is unit-testable without any IO.

/** What `ymmv set` targets — a curated key/value or a free-form extra. */
export type SetTarget =
  | { kind: "curated"; key: CuratedKey; value: string }
  | { kind: "extra"; label: string; value: string };

export type Command =
  | { kind: "publish"; yes: boolean }
  | { kind: "view"; handle: string }
  | { kind: "login" }
  | { kind: "logout" }
  | { kind: "set"; target: SetTarget }
  | { kind: "delete"; yes: boolean }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

const SET_USAGE = 'usage: ymmv set <key> <value>  |  ymmv set --extra "Label=Value"';
const EXTRA_USAGE = 'usage: ymmv set --extra "Label=Value"';

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
    return { kind: "set", target: { kind: "extra", label, value } };
  }
  if (!head) return { kind: "error", message: SET_USAGE };
  if (!isCuratedKey(head)) {
    return {
      kind: "error",
      message:
        `"${head}" is not a curated key. Valid keys: ${CURATED_KEYS.join(", ")}.\n` +
        'For anything else, use: ymmv set --extra "Label=Value".',
    };
  }
  const value = rest.slice(1).join(" ").trim();
  if (!value) return { kind: "error", message: `usage: ymmv set ${head} <value>` };
  return { kind: "set", target: { kind: "curated", key: head, value } };
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
  if (first === "view") {
    const handle = argv[1];
    if (!handle) return { kind: "error", message: "usage: ymmv view <handle>" };
    if (!isValidHandle(handle)) {
      return { kind: "error", message: `"${handle}" is not a valid GitHub handle.` };
    }
    return { kind: "view", handle };
  }

  // Anything else: an unknown flag is an error; otherwise it's a bare handle to view.
  if (first.startsWith("-")) {
    return { kind: "error", message: `unknown option "${first}". Run \`ymmv help\`.` };
  }
  if (!isValidHandle(first)) {
    return {
      kind: "error",
      message: `"${first}" is not a valid GitHub handle. Run \`ymmv help\`.`,
    };
  }
  return { kind: "view", handle: first };
}
