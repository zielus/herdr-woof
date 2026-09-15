import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

type Status = "trusted" | "untrusted" | "unknown";
let trustStatusFromJson: (text: string, dirs: readonly string[]) => Status;

beforeAll(async () => {
  ({ trustStatusFromJson } = await loadDist<{ trustStatusFromJson: typeof trustStatusFromJson }>(
    "runtime/claude/trust.js",
  ));
});

describe("claude trust status from .claude.json text", () => {
  it("is trusted only when an exact directory key accepted the dialog", () => {
    const text = JSON.stringify({
      projects: {
        "/work/repo": { hasTrustDialogAccepted: true },
        "/work/other": { hasTrustDialogAccepted: false },
      },
    });
    expect(trustStatusFromJson(text, ["/work/repo"])).toBe("trusted");
    // The realpath key counts too.
    expect(trustStatusFromJson(text, ["/link/repo", "/work/repo"])).toBe("trusted");
    expect(trustStatusFromJson(text, ["/work/other"])).toBe("untrusted");
    // An ancestor's trust does not count for a nested directory.
    expect(trustStatusFromJson(text, ["/work/repo/sub"])).toBe("untrusted");
  });

  it("requires the literal true", () => {
    const text = JSON.stringify({ projects: { "/r": { hasTrustDialogAccepted: "true" } } });
    expect(trustStatusFromJson(text, ["/r"])).toBe("untrusted");
  });

  it("is unknown for unparseable text or a missing projects object", () => {
    expect(trustStatusFromJson("{", ["/r"])).toBe("unknown");
    expect(trustStatusFromJson("[]", ["/r"])).toBe("unknown");
    expect(trustStatusFromJson(JSON.stringify({ projects: [] }), ["/r"])).toBe("unknown");
    expect(trustStatusFromJson(JSON.stringify({ other: 1 }), ["/r"])).toBe("unknown");
  });

  it("does not read inherited keys", () => {
    expect(trustStatusFromJson(JSON.stringify({ projects: {} }), ["constructor"])).toBe(
      "untrusted",
    );
  });
});
