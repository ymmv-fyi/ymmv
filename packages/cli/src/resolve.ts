import {
  CLI_VERBS,
  CURATED_KEYS,
  type CuratedKey,
  isReserved,
  isValidHandle,
  KEY_LABELS,
  MAX_LABEL,
  MAX_VALUE,
} from "@ymmv/shared";
import { sanitizeValue, showsVisibleText } from "./render.js";

// Argument resolution. The bare `ymmv <handle>` form stays primary, the verb words
// (login/logout/set/unset/delete/view/help/publish/version/update) dispatch as verbs, and
// `ymmv view <handle>` is the explicit alias for viewing (every verb word is also a reserved
// handle, so a verb-colliding profile cannot exist — both view paths reject reserved names
// locally rather than making a round-trip that misreports "no profile yet"). Either view form
// takes a `vs <handle>` tail to diff two profiles, like the web's /<a>/vs/<b>. Verbs reject
// unexpected trailing tokens instead of dropping them — `ymmv -y delete` must never read as a
// consented publish, and `ymmv delete oldname -y` must never read as a consented delete.
// A whole-token -h/--help anywhere after a verb (or after a bare handle) outranks every other
// token and prints that verb's usage, so `ymmv set editor --help` and `ymmv delete -y --help`
// never run. Pure + total: every argv maps to exactly one Command (including `error`), so
// dispatch in index.ts is a flat switch and the whole table is unit-testable without any IO.

/** What `ymmv set` targets — a curated key/value or a free-form extra. */
export type SetTarget =
  | { kind: "curated"; key: CuratedKey; value: string }
  | { kind: "extra"; label: string; value: string };

/** What `ymmv unset` targets — a curated key or a free-form extra's label. `typed` is the name
 *  as the user wrote it, present only when that was not the key itself (`Theme`, `window_manager`).
 *  Only runUnset has the stored profile, and it needs to know: a profile can hold an extra labeled
 *  like a curated field, and a name that is not the exact key could mean either row. */
export type UnsetTarget =
  | { kind: "curated"; key: CuratedKey; typed?: string }
  | { kind: "extra"; label: string };

export type Command =
  | { kind: "publish"; yes: boolean; resetMarks: boolean }
  | { kind: "view"; handle: string }
  | { kind: "compare"; theirs: string; mine: string }
  | { kind: "login"; yes: boolean }
  | { kind: "logout" }
  | { kind: "set"; target: SetTarget }
  | { kind: "unset"; target: UnsetTarget }
  | { kind: "delete"; yes: boolean }
  | { kind: "update" }
  | { kind: "help"; usage?: string }
  | { kind: "version" }
  | { kind: "error"; message: string };

// The --extra invocation shapes, written once — usage strings and error hints compose from these.
const SET_EXTRA = 'ymmv set --extra "Label=Value"';
const UNSET_EXTRA = 'ymmv unset --extra "Label"';
const SET_USAGE = `usage: ymmv set <key> <value>  |  ${SET_EXTRA}`;
const EXTRA_USAGE = `usage: ${SET_EXTRA}`;
const UNSET_USAGE = `usage: ymmv unset <key>  |  ${UNSET_EXTRA}`;
const VIEW_USAGE = "usage: ymmv view <handle> [vs <handle>]";
const LOGIN_USAGE = "usage: ymmv login [-y]";
const PUBLISH_USAGE = "usage: ymmv publish [-y | --reset-marks]";
// Each verb's usage line, written once — `ymmv help <verb>`, `<verb> --help` and the verb's
// general usage error all print it (argument-specific errors, like set's, keep their own text).
const VERB_USAGE = {
  login: LOGIN_USAGE,
  logout: "usage: ymmv logout",
  update: "usage: ymmv update",
  publish: PUBLISH_USAGE,
  delete: "usage: ymmv delete [-y] (deletes your own profile; takes no handle)",
  set: SET_USAGE,
  unset: UNSET_USAGE,
  view: VIEW_USAGE,
  version: "usage: ymmv version",
} as const;
type Verb = keyof typeof VERB_USAGE;

function isHelpFlag(token: string | undefined): boolean {
  return token === "-h" || token === "--help";
}

function isVerb(token: string | undefined): token is Verb {
  return token !== undefined && Object.hasOwn(VERB_USAGE, token);
}

function verbHelp(verb: Verb): Command {
  const keys =
    verb === "set" || verb === "unset" ? `\nValid keys: ${CURATED_KEYS.join(", ")}.` : "";
  return { kind: "help", usage: VERB_USAGE[verb] + keys };
}

/** How a field name compares: case aside, with a hyphen, an underscore and a space all one
 *  separator ("Window manager" and `window_manager` both name `window-manager`). Trimmed last as
 *  well as first: a half-typed `os-` folds to `os `, and the trailing space would then match
 *  nothing. `set`, `unset` and the "Which field" prompt all compare through this one fold, so a
 *  spelling one of them takes is a spelling the others take. */
export const fieldName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[-_\s]+/g, " ")
    .trim();

const fieldNames = (key: CuratedKey): string[] => [fieldName(key), fieldName(KEY_LABELS[key])];

/** The curated key a name spells out in full, by key or by label. This is all a write takes:
 *  `set` and `unset` turn anything looser (a prefix, a near miss) into a suggestion, because a
 *  guessed key stores or removes the wrong row. Unquoted `ymmv set Window Manager yabai` would
 *  otherwise save "Manager yabai" as the window manager. */
function namedField(name: string): CuratedKey | undefined {
  const typed = fieldName(name);
  return CURATED_KEYS.find((key) => fieldNames(key).includes(typed));
}

/** The curated key an answer to "Which field" names, by key or by label: an exact name wins, else
 *  a prefix ("win" is Window manager). Several keys back means the prefix fits them all ("t" is
 *  Terminal and Theme), none means nothing matched; either way the caller re-asks. */
export function resolveField(answer: string): CuratedKey | readonly CuratedKey[] | undefined {
  const typed = fieldName(answer);
  if (typed === "") return undefined;
  const exact = namedField(typed);
  if (exact !== undefined) return exact;
  const hits = CURATED_KEYS.filter((key) => fieldNames(key).some((n) => n.startsWith(typed)));
  return hits.length === 1 ? hits[0] : hits.length === 0 ? undefined : hits;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1).fill(0);

  for (let i = 0; i < a.length; i++) {
    curr[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      const insertCost = (curr[j] ?? 0) + 1;
      const deleteCost = (prev[j + 1] ?? 0) + 1;
      const substCost = (prev[j] ?? 0) + cost;
      curr[j + 1] = Math.min(insertCost, deleteCost, substCost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? b.length;
}

/** The keys to offer for a name `set` or `unset` refused. What the "Which field" prompt would
 *  take comes first, both keys when a prefix fits two ("t"): the user picks, the CLI never does.
 *  Failing that, the one key within a small edit distance ("teminal", "aitool"). Fewer than three
 *  characters is too little to measure, and the two-letter `os` is left out because any
 *  three-letter word is close to it. */
function suggestKeys(head: string): readonly CuratedKey[] {
  const field = resolveField(head);
  if (field !== undefined) return typeof field === "string" ? [field] : field;
  const typed = fieldName(head);
  if (typed.length < 3) return [];
  let best: CuratedKey | undefined;
  let bestDist = typed.length <= 4 ? 2 : 3;
  for (const key of CURATED_KEYS) {
    if (key.length < 4) continue;
    const dist = editDistance(typed, fieldName(key));
    if (dist < bestDist) {
      bestDist = dist;
      best = key;
    }
  }
  return best === undefined ? [] : [best];
}

/** The curated unset that both `unset <key>` and `set <key> -` resolve to. */
function curatedUnset(key: CuratedKey, head: string): Command {
  return {
    kind: "unset",
    target: head === key ? { kind: "curated", key } : { kind: "curated", key, typed: head },
  };
}

/** One source of truth for the not-a-curated-key error; each verb supplies its own extras hint.
 *  `head` is raw argv, so strip escapes before echoing (same rule as the handle branches). The
 *  suggestion is built from curated keys alone, so it needs no stripping. */
function invalidKeyError(head: string, hint: string): Command {
  const keys = suggestKeys(head).map((key) => `"${key}"`);
  const last = keys.pop();
  const others = keys.length > 0 ? `${keys.join(", ")} or ` : "";
  const didYouMean = last === undefined ? "" : ` Did you mean ${others}${last}?`;
  return {
    kind: "error",
    message:
      `"${sanitizeValue(head)}" is not a curated key.${didYouMean} Valid keys: ${CURATED_KEYS.join(", ")}.\n` +
      `For anything else, use: ${hint}.`,
  };
}

/** Verbs that take nothing: any trailing token is a usage error, never silently dropped. */
function noArgs(verb: "logout" | "update", rest: string[]): Command {
  return rest.length === 0 ? { kind: verb } : { kind: "error", message: VERB_USAGE[verb] };
}

/** Verbs whose only extra token may be -y/--yes — consent stays scoped to this one command,
 *  so `delete oldname -y` and `delete -y -y` are errors, never a consented delete. */
function yesOnly(usage: string, rest: string[], make: (yes: boolean) => Command): Command {
  if (rest.length === 0) return make(false);
  if (rest.length === 1 && (rest[0] === "-y" || rest[0] === "--yes")) return make(true);
  return { kind: "error", message: usage };
}

/** publish's one optional flag: -y/--yes or --reset-marks, never both (-y shows no marks, so the
 *  pair has nothing to mean). Shared by `ymmv publish <flag>` and the bare `ymmv --reset-marks`. */
function publishFlags(flags: string[]): Command {
  if (flags.length === 1 && flags[0] === "--reset-marks") {
    return { kind: "publish", yes: false, resetMarks: true };
  }
  return yesOnly(PUBLISH_USAGE, flags, (yes) => ({ kind: "publish", yes, resetMarks: false }));
}

// Pre-flight the shared write rules at the argv boundary: the server would 422 these anyway, but
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
// A value of only zero-width/format code points survives parseSet's `!value` emptiness test and
// would be the server's `invalid_value` after the round trip (see @ymmv/shared visible.ts);
// showsVisibleText also refuses what would render blank on the card (render.ts).
function labelInvisibleError(): Command {
  return { kind: "error", message: "That label has no visible text." };
}
function valueInvisibleError(): Command {
  return { kind: "error", message: "That value has no visible text." };
}

/** The key `set` or `unset` acts on. A name typed like a flag is never one: the fold drops a
 *  leading hyphen, so `--theme` would otherwise name the theme, and a flag this CLI does not have
 *  must stay an error. */
function writeKey(head: string): CuratedKey | undefined {
  return head.startsWith("-") ? undefined : namedField(head);
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
    // deliberately unrepresentable — that's the footgun this rewrite removes). Checked before the
    // label rules on purpose: a clear is a match-only lookup, never a store, so an over-cap or
    // invisible-only label is a harmless miss there (the cap test pins this order).
    if (value === "-") return { kind: "unset", target: { kind: "extra", label } };
    if (!showsVisibleText(label)) return labelInvisibleError();
    if (!showsVisibleText(value)) return valueInvisibleError();
    if (label.length > MAX_LABEL) return labelCapError(label);
    if (value.length > MAX_VALUE) return valueCapError(value);
    return { kind: "set", target: { kind: "extra", label, value } };
  }
  if (!head) return { kind: "error", message: SET_USAGE };
  const key = writeKey(head);
  if (key === undefined) return invalidKeyError(head, SET_EXTRA);
  const value = rest.slice(1).join(" ").trim();
  if (!value) return { kind: "error", message: `usage: ymmv set ${key} <value>` };
  // Same "-" clears convention as promptEntries; only an exactly-"-" trimmed value triggers it,
  // so multi-token values like "- foo" or "Fira-Code" stay literal sets.
  if (value === "-") return curatedUnset(key, head);
  if (!showsVisibleText(value)) return valueInvisibleError();
  if (value.length > MAX_VALUE) return valueCapError(value);
  return { kind: "set", target: { kind: "curated", key, value } };
}

function parseUnset(rest: string[]): Command {
  const head = rest[0];
  if (head === "--extra" || head === "-e") {
    // Everything after --extra is the label (joined so unquoted spaces survive, like parseSet).
    const label = rest.slice(1).join(" ").trim();
    if (!label) return { kind: "error", message: `usage: ${UNSET_EXTRA}` };
    // Over the cap can never be stored, so it can never match: fail here, before any login or GET.
    if (label.length > MAX_LABEL) return labelCapError(label);
    // No visibility pre-flight, unlike parseSet: an invisible-only label could be stored before
    // the server refused them, and unset is how such a label gets removed.
    // No "=" rule here: a curl-written label may contain one, and only runUnset (with the stored
    // profile in hand) can tell a real match from muscle-memory "Label=Value".
    return { kind: "unset", target: { kind: "extra", label } };
  }
  if (!head) return { kind: "error", message: UNSET_USAGE };
  const key = writeKey(head);
  if (key === undefined) return invalidKeyError(head, UNSET_EXTRA);
  // A trailing value almost certainly means the user meant `set`; silently unsetting would be a
  // destructive surprise.
  if (rest.length > 1) return { kind: "error", message: `usage: ymmv unset ${key}` };
  return curatedUnset(key, head);
}

export function resolveArg(argv: string[]): Command {
  const first = argv[0];
  const rest = argv.slice(1);

  // Global help/version. `ymmv help` and a leading -h/--help print the general block, and so
  // does an unknown `ymmv help <topic>`, so trailing tokens stay non-breaking. `ymmv help <verb>`
  // and a -h/--help token anywhere after a verb print that verb's usage, before any verb parser
  // runs: `set editor --help` would otherwise publish "--help", and `delete -y --help` must not
  // read as consent. Only a whole token counts, so `set --extra "Flags=-h"` still stores -h; the
  // cost is that a bare "--help" value is unrepresentable, the same trade "-" makes for clear.
  // Version is strict like every other verb.
  if (first === "-h" || first === "--help") return { kind: "help" };
  if (first === "help") return isVerb(rest[0]) ? verbHelp(rest[0]) : { kind: "help" };
  if (isVerb(first) && rest.some(isHelpFlag)) return verbHelp(first);
  if (first === "-V" || first === "-v" || first === "--version" || first === "version") {
    return rest.length === 0 ? { kind: "version" } : { kind: "error", message: VERB_USAGE.version };
  }

  // Bare `ymmv` (optionally `-y`) → publish, the default magic. A flag-first tail is refused:
  // the -y consent was given for whatever follows (`ymmv -y delete`), not for a publish.
  if (first === undefined) return { kind: "publish", yes: false, resetMarks: false };
  if (first === "-y" || first === "--yes") {
    // -y shows no marks, so the pair has nothing to mean: say so, not "put -y after the command".
    if (rest[0] === "--reset-marks") return { kind: "error", message: PUBLISH_USAGE };
    if (rest.length > 0) {
      // Echo the user's own intent when it's a yes-accepting verb; never advertise the
      // destructive delete form to someone who typed something else.
      const example =
        rest[0] === "delete" || rest[0] === "publish" || rest[0] === "login" ? rest[0] : "publish";
      return {
        kind: "error",
        message: `Put ${first} after the command: ymmv ${example} -y. A bare ymmv -y publishes without prompts.`,
      };
    }
    return { kind: "publish", yes: true, resetMarks: false };
  }
  if (first === "--reset-marks") return publishFlags(argv);

  // Reserved verbs. Help has already been handled above.
  if (first === "logout" || first === "update") return noArgs(first, rest);
  if (first === "login") {
    return yesOnly(LOGIN_USAGE, rest, (yes) => ({ kind: "login", yes }));
  }
  if (first === "publish") return publishFlags(rest);
  if (first === "delete") {
    return yesOnly(VERB_USAGE.delete, rest, (yes) => ({ kind: "delete", yes }));
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
    if (rest.length > 1)
      return versusTail(handle, rest.slice(1)) ?? { kind: "error", message: VIEW_USAGE };
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
  // The bare handle IS view, so a late help flag gets view's usage, like `view <handle> --help`.
  // Checked after the shape and reserved checks: `ymmv Set editor --help` keeps its verb hint.
  if (rest.some(isHelpFlag)) return verbHelp("view");
  const versus = versusTail(first, rest);
  if (versus) return versus;
  if (rest.length > 0) {
    return { kind: "error", message: `Unexpected arguments after "${first}". Run \`ymmv help\`.` };
  }
  return { kind: "view", handle: first };
}

/** `<a> vs <b>`, the CLI's spelling of the web's /<a>/vs/<b>: a tail of exactly `vs` and one
 *  more handle, checked the way the first one is. Undefined for any other tail, which keeps the
 *  caller's own error. `vs` is only a keyword here, so `ymmv vs` still views a user named vs. */
function versusTail(theirs: string, tail: readonly string[]): Command | undefined {
  const [word, mine] = tail;
  if (tail.length !== 2 || word !== "vs" || mine === undefined) return undefined;
  if (!isValidHandle(mine)) {
    return { kind: "error", message: `"${sanitizeValue(mine)}" is not a valid GitHub handle.` };
  }
  if (isReserved(mine)) return reservedError(mine);
  return { kind: "compare", theirs, mine };
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
