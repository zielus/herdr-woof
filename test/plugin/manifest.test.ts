import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

interface HerdrPluginManifest {
  id: string;
  name: string;
  version: string;
  min_herdr_version: string;
  platforms: string[];
  build: Array<{ command: string[] }>;
  actions: Array<{ id: string; command: string[] }>;
  panes: Array<{ id: string; placement: string; command: string[] }>;
  events?: unknown;
}

async function readManifest(): Promise<HerdrPluginManifest> {
  const text = await readFile(join(repoRoot, "herdr-plugin.toml"), "utf8");
  return parse(text) as unknown as HerdrPluginManifest;
}

describe("herdr-plugin.toml", () => {
  it("identifies the plugin", async () => {
    const manifest = await readManifest();
    expect(manifest.id).toBe("herdr-woof");
    expect(manifest.name).toBe("Woof");
    expect(manifest.min_herdr_version).toBe("0.9.0");
    expect(manifest.platforms.toSorted()).toEqual(["linux", "macos"]);
  });

  it("keeps its version in sync with package.json", async () => {
    const manifest = await readManifest();
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    expect(manifest.version).toBe(pkg.version);
  });

  it("builds by installing dependencies then running the build script", async () => {
    const manifest = await readManifest();
    expect(manifest.build).toHaveLength(2);
    expect(manifest.build[0]?.command).toEqual(["bun", "install", "--frozen-lockfile"]);
    expect(manifest.build[1]?.command).toEqual(["bun", "run", "build"]);
  });

  it("declares doctor and runs actions", async () => {
    const manifest = await readManifest();
    const ids = manifest.actions.map((action) => action.id).toSorted();
    expect(ids).toEqual(["doctor", "runs"]);
    const doctor = manifest.actions.find((action) => action.id === "doctor");
    expect(doctor?.command).toEqual(["bin/woof", "doctor"]);
    const runs = manifest.actions.find((action) => action.id === "runs");
    expect(runs?.command).toEqual(["bin/woof", "runs"]);
  });

  it("declares a runtime pane placed as a tab", async () => {
    const manifest = await readManifest();
    expect(manifest.panes).toHaveLength(1);
    const runtime = manifest.panes[0];
    expect(runtime?.id).toBe("runtime");
    expect(runtime?.placement).toBe("tab");
    expect(runtime?.command).toEqual(["bin/woof", "runtime"]);
  });

  it("declares no events", async () => {
    const manifest = await readManifest();
    expect(manifest.events).toBeUndefined();
  });
});
