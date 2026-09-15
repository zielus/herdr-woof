// Loading a definition executes its code: this module writes a marker file.
import { writeFileSync } from "node:fs";

const marker = process.env["WOOF_TEST_MARKER"];
if (marker !== undefined) writeFileSync(marker, "loaded\n");

export default { schemaVersion: 1 };
