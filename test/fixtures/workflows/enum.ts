// Enums are not erasable syntax: Node's type stripping refuses this module.
enum Stage {
  Draft = "draft",
}

export default { schemaVersion: 1, name: "fixture-enum", version: "1", start: Stage.Draft };
