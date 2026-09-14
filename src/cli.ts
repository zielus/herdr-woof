#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import { VERSION } from "./version.js";

const [command] = process.argv.slice(2);

if (command === undefined || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "--version" || command === "-V") {
  console.log(VERSION);
} else if (command === "doctor") {
  console.log(`woof ${VERSION}`);
  console.log(probe("herdr", ["status"]));
  console.log(probe("claude", ["--version"]));
} else {
  console.error(`woof: ${command} is not implemented in the SDK foundation`);
  process.exitCode = 1;
}

function printHelp(): void {
  console.log("Usage: woof <command>");
  console.log("");
  console.log("Commands:");
  console.log("  doctor     Report Herdr and Claude Code availability");
  console.log("");
  console.log("Workflow orchestration is not implemented in this foundation.");
}

function probe(commandName: string, args: readonly string[]): string {
  const label = `${commandName} ${args.join(" ")}`;
  const result = spawnSync(commandName, args, { encoding: "utf8" });

  if (result.error !== undefined && "code" in result.error && result.error.code === "ENOENT") {
    return `${label}: not found`;
  }
  if (result.status === 0) {
    const output = result.stdout.trim();
    return output === "" ? `${label}: available` : `${label}:\n${indent(output)}`;
  }

  const detail =
    result.stderr.trim() || result.error?.message || `exit ${result.status ?? "unknown"}`;
  return `${label}: failed (${detail.split("\n")[0]})`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
