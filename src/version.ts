import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Package version, sourced from the installed package metadata. */
export const VERSION: string = (require("../package.json") as { version: string }).version;
