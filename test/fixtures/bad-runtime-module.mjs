// Runtime module for CLI tests whose factory returns an object that is not a RuntimeAdapter.
export default function createRuntime() {
  return { adapter: "scripted", observe: async () => ({ ok: true }) };
}
