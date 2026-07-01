import { describe, expect, it } from "vitest";
import { parseExtras } from "../src/lib/profile-read.ts";

// parseExtras' contract is "one bad row can't 500 a read" — that includes element shape,
// since a non-string value reaches .replace()/safeHref in render and would throw.
describe("parseExtras", () => {
  it("keeps well-formed extras", () => {
    expect(parseExtras('[{"label":"Keyboard","value":"HHKB Pro 2"}]')).toEqual([
      { label: "Keyboard", value: "HHKB Pro 2" },
    ]);
  });

  it("drops malformed elements instead of letting render throw", () => {
    const json = '[{"label":"K","value":"V"},null,"str",{"label":"x","value":2},{"value":"v"}]';
    expect(parseExtras(json)).toEqual([{ label: "K", value: "V" }]);
  });

  it("tolerates non-array JSON, invalid JSON, and null input", () => {
    expect(parseExtras('{"a":1}')).toEqual([]);
    expect(parseExtras("not json")).toEqual([]);
    expect(parseExtras(null as unknown as string)).toEqual([]);
  });
});
