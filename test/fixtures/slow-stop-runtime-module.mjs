// Runtime module for signal tests (PI-001): the scripted runtime whose stop()
// waits WOOF_TEST_STOP_DELAY_MS (default 3000) first, so a host that was asked
// to cancel is still settling when a second signal arrives.
import createScriptedRuntime from "./scripted-runtime-module.mjs";

export default async function createRuntime(context) {
  const created = await createScriptedRuntime(context);
  const delayMs = Number(process.env["WOOF_TEST_STOP_DELAY_MS"] ?? "3000");
  return {
    ...created,
    async stop(handle, options) {
      await new Promise((done) => setTimeout(done, delayMs));
      return created.stop(handle, options);
    },
  };
}
