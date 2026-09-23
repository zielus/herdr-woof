// Runtime module for composition tests: the scripted runtime whose stop() always fails, so a run
// ends with `runtime_cleanup_failed` (an agent pane it could not stop) after its outcome.
import createScriptedRuntime from "./scripted-runtime-module.mjs";

export default async function createRuntime(context) {
  const created = await createScriptedRuntime(context);
  return {
    ...created,
    async stop() {
      return { ok: false, error: { code: "runtime_error", message: "the pane would not close" } };
    },
  };
}
