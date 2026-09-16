import { SEMVER } from "../../lib/metadata.js";

/** Compares two valid semver versions by precedence (semver.org §11); build metadata is ignored. */
export function compareSemver(a: string, b: string): number {
  const [left, right] = [SEMVER.exec(a), SEMVER.exec(b)];
  if (left === null || right === null) throw new TypeError(`not semver: ${a} or ${b}`);
  for (const index of [1, 2, 3]) {
    const diff = Number(left[index]) - Number(right[index]);
    if (diff !== 0) return Math.sign(diff);
  }
  const [pa, pb] = [left[4], right[4]];
  if (pa === undefined || pb === undefined) return pa === pb ? 0 : pa === undefined ? 1 : -1;
  const [ia, ib] = [pa.split("."), pb.split(".")];
  for (let at = 0; at < Math.max(ia.length, ib.length); at += 1) {
    const [x, y] = [ia[at], ib[at]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny && Number(x) !== Number(y)) return Math.sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
