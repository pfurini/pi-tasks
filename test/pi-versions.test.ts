/**
 * Pi version drift guard.
 *
 * package.json is the only place that states a Pi version (AGENTS.md, "Pi Compatibility").
 * These tests fail when its entries disagree with each other or with package-lock.json, or
 * when a version is written somewhere a bump would not reach.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));

const piEntries = (deps: Record<string, string> = {}) =>
  Object.entries(deps).filter(([name]) => name.startsWith("@earendil-works/pi-"));
const peers = piEntries(pkg.peerDependencies);
const pins = piEntries(pkg.devDependencies);

const VERSION = /\b\d+\.\d+\.\d+\b/;

function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map(v => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Lines of `text` matching `pattern`, as `line N: text` for a readable failure. */
function matching(text: string, pattern: RegExp): string[] {
  return text.split("\n").flatMap((line, i) => (pattern.test(line) ? [`line ${i + 1}: ${line.trim()}`] : []));
}

/** The body of the `## <title>` section of a markdown file. */
function section(markdown: string, title: string): string {
  const start = markdown.indexOf(`## ${title}\n`);
  if (start < 0) throw new Error(`section "${title}" not found`);
  const end = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, end < 0 ? undefined : end);
}

describe("Pi versions", () => {
  it("peer-depends on every Pi package from one floor", () => {
    expect(peers.length).toBeGreaterThan(0);
    for (const [name, range] of peers) expect(range, name).toMatch(/^>=\d+\.\d+\.\d+$/);
    expect(new Set(peers.map(([, range]) => range)).size).toBe(1);
  });

  it("pins every Pi package at one exact version, at or above the floor", () => {
    for (const [name, version] of pins) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(pins.map(([, version]) => version)).size).toBe(1);
    const floor = peers[0][1].slice(2);
    expect(compareVersions(pins[0][1], floor)).toBeGreaterThanOrEqual(0);
  });

  it("pins every Pi package it peer-depends on", () => {
    for (const [name] of peers) expect(Object.keys(pkg.devDependencies)).toContain(name);
  });

  it("pins the typebox that the pinned Pi depends on", () => {
    const pi = lock.packages["node_modules/@earendil-works/pi-coding-agent"];
    expect(pkg.devDependencies.typebox).toBe(pi.dependencies.typebox);
  });

  it("has a lockfile that matches package.json", () => {
    const root = lock.packages[""];
    expect(root.peerDependencies).toEqual(pkg.peerDependencies);
    expect(root.devDependencies).toEqual(pkg.devDependencies);
    for (const [name, version] of [...pins, ["typebox", pkg.devDependencies.typebox]]) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
    }
  });

  it("states no version in CI, the install script or the compatibility rules", () => {
    expect(matching(read(".github/workflows/ci.yml"), VERSION)).toEqual([]);
    expect(matching(read(".github/scripts/install-pi.sh"), VERSION)).toEqual([]);
    expect(matching(section(read("AGENTS.md"), "Pi Compatibility"), VERSION)).toEqual([]);
  });

  it("states no pinned Pi install or version range in the docs", () => {
    const pinned = /@earendil-works\/pi-[\w-]+@\d|typebox@\d|>=\s*\d/;
    for (const file of ["AGENTS.md", "README.md", "CONTRIBUTING.md", "CUSTOMIZING.md"]) {
      expect(matching(read(file), pinned), file).toEqual([]);
    }
  });
});
