#!/usr/bin/env node
/**
 * `woof`: the CLI entry point invoked by `bin/woof`, by the herdr plugin's
 * `doctor`/`runs` actions, and by the `runtime` pane. No orchestration logic
 * yet — each subcommand is a stub that proves the wiring end to end.
 */
import { execFileSync } from "node:child_process";

import { Command } from "commander";

import { VERSION } from "./version.js";

const program = new Command();

program.name("woof").description("Woof — orchestrate coding agents on Herdr").version(VERSION);

program
  .command("doctor")
  .description("Check herdr and Claude Code availability")
  .action(() => {
    console.log(`woof ${VERSION}`);
    console.log(probe("herdr", ["status"]));
    console.log(probe("claude", ["--version"]));
  });

program
  .command("runs")
  .description("List woof runs")
  .action(() => {
    console.log("no runs");
  });

program
  .command("runtime")
  .description("Run the herdr `runtime` pane")
  .action(() => {
    const runDir = process.env["WOOF_RUN_DIR"];
    console.log(`WOOF_RUN_DIR=${runDir ?? "(unset)"}`);
  });

await program.parseAsync(process.argv);

/** Runs a diagnostic command and reports its outcome; never throws. */
function probe(command: string, args: readonly string[]): string {
  const label = `${command} ${args.join(" ")}`;
  try {
    const output = execFileSync(command, [...args], { encoding: "utf8" }).trim();
    return `${label}:\n${indent(output)}`;
  } catch (error) {
    // execFileSync throws with `code: "ENOENT"` when the binary itself is
    // missing, and a plain non-zero-exit Error (carrying stderr/stdout)
    // when the binary ran and failed — those are different diagnoses and
    // doctor should not conflate "not installed" with "installed but broken".
    if (isErrnoException(error) && error.code === "ENOENT") {
      return `${label}: not found`;
    }
    const stderr = isExecError(error) ? error.stderr.trim() : "";
    const detail = stderr !== "" ? stderr : error instanceof Error ? error.message : String(error);
    return `${label}: failed (${detail.split("\n")[0]})`;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// execFileSync is called with `encoding: "utf8"`, so a non-zero-exit error's
// stderr comes back as a string, not the Buffer it would default to.
function isExecError(error: unknown): error is Error & { stderr: string } {
  return error instanceof Error && typeof (error as { stderr?: unknown }).stderr === "string";
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
