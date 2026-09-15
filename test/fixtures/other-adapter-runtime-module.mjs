// Runtime module for CLI tests: a complete adapter whose discriminator is neither "herdr" nor "scripted".
import createScriptedRuntime from "./scripted-runtime-module.mjs";

export default async function createRuntime(context) {
  const runtime = await createScriptedRuntime(context);
  return { ...runtime, adapter: "other" };
}
