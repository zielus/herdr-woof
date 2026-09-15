// Runtime module for pre-open signal tests (PI-101): the factory records that it
// was entered by creating WOOF_TEST_ENTERED, then never resolves and keeps the
// event loop alive, like a runtime factory stuck on a slow dependency.
import { writeFileSync } from "node:fs";

export default async function createRuntime() {
  const entered = process.env["WOOF_TEST_ENTERED"];
  if (entered !== undefined) writeFileSync(entered, `${process.pid}\n`);
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
}
