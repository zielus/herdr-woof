export { discoverRoots } from "./discover.js";
export type { ConfigRoots, ConfigWarning, DiscoverOptions } from "./discover.js";
export { loadScope, readConfigFile } from "./read.js";
export type { FileRef, ScopeContent } from "./read.js";
export {
  DEFAULT_HOST_START_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  DEFAULT_WORKFLOW,
  builtinCatalog,
  composeConfiguration,
  describeSource,
  resolveConfiguration,
} from "./resolve.js";
export type {
  BuiltinCatalog,
  ComposeInput,
  ConfigFlags,
  Provenance,
  ResolveConfigurationResult,
  ResolvedConfiguration,
} from "./resolve.js";
export { configuresPermissionBypass, validateRoleFile, validateSettingsFile } from "./schema.js";
export type {
  ConfigDetail,
  ConfigFailure,
  ConfigReason,
  ConfigScope,
  ConfigSource,
  RoleFile,
  RoleValue,
  SettingsDefaults,
} from "./schema.js";
