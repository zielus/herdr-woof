/**
 * Public SDK entry point.
 *
 * The orchestration contracts are intentionally not published yet. Keeping
 * this module free of CLI and plugin imports establishes the package boundary
 * without committing to an API before the first SDK slice is specified. The
 * package's ESM metadata makes this compiled file importable as a module.
 */
export const SDK_FOUNDATION = true;
