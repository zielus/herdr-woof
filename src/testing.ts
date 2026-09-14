/**
 * `herdr-woof/testing`: test doubles for workflow authors (p2 contract,
 * unstable until v1). The scripted runtime implements the same RuntimeAdapter
 * contract as the Herdr CLI adapter, deterministically and in memory. It is
 * kept out of the main entry so it is never mistaken for a production runtime.
 */
export { createScriptedRuntime } from "./runtime/scripted.js";
export type {
  DeliverScript,
  ScriptedAgent,
  ScriptedCall,
  ScriptedRuntime,
  TimelineEntry,
} from "./runtime/scripted.js";
