import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Version of the installed package, read from its own package.json. */
export const VERSION: string = (require("../package.json") as { version: string }).version;
