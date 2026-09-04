/**
 * CLI argument tests.
 *
 * `--allow-dir` decides how much of the filesystem the server may read, so the
 * cases that matter are the ones where a typo could widen that access or
 * silently disable it: an empty value resolves to the process cwd, and an
 * unrecognized flag would otherwise start a server with local reading off and
 * no explanation.
 */

import { describe, expect, it } from "vitest";
import { parseArgs } from "./bin";

describe("parseArgs", () => {
  it("takes no flags at all", () => {
    expect(parseArgs([])).toEqual({
      allowedDirectories: [],
      playerOrigin: undefined,
      unrecognized: [],
    });
  });

  it("reads both flags in the space-separated form", () => {
    const parsed = parseArgs([
      "--allow-dir",
      "/tmp/recordings",
      "--player-origin",
      "http://localhost:5173",
    ]);

    expect(parsed.allowedDirectories).toEqual(["/tmp/recordings"]);
    expect(parsed.playerOrigin).toBe("http://localhost:5173");
    expect(parsed.unrecognized).toEqual([]);
  });

  it("reads both flags in the `=` form", () => {
    const parsed = parseArgs([
      "--allow-dir=/tmp/recordings",
      "--player-origin=http://localhost:5173",
    ]);

    expect(parsed.allowedDirectories).toEqual(["/tmp/recordings"]);
    expect(parsed.playerOrigin).toBe("http://localhost:5173");
    expect(parsed.unrecognized).toEqual([]);
  });

  it("collects a repeated --allow-dir in order", () => {
    const parsed = parseArgs(["--allow-dir", "/a", "--allow-dir=/b", "--allow-dir", "/c"]);

    expect(parsed.allowedDirectories).toEqual(["/a", "/b", "/c"]);
  });

  it("keeps the last --player-origin when it is given twice", () => {
    expect(
      parseArgs(["--player-origin=http://first", "--player-origin=http://second"]).playerOrigin,
    ).toBe("http://second");
  });

  it("does not allow-list anything for an empty --allow-dir value", () => {
    // `--allow-dir=` used to push "", which resolves to the process cwd and
    // grants read access to the whole working directory.
    const parsed = parseArgs(["--allow-dir="]);

    expect(parsed.allowedDirectories).toEqual([]);
    expect(parsed.unrecognized).toEqual(["--allow-dir="]);
  });

  it("does not override the player origin with an empty value", () => {
    const parsed = parseArgs(["--player-origin="]);

    expect(parsed.playerOrigin).toBeUndefined();
    expect(parsed.unrecognized).toEqual(["--player-origin="]);
  });

  it("ignores a trailing flag with no value instead of storing undefined", () => {
    const parsed = parseArgs(["--allow-dir"]);

    expect(parsed.allowedDirectories).toEqual([]);
    expect(parsed.unrecognized).toEqual(["--allow-dir"]);
  });

  it("reports a misspelled flag and does not consume its value as a directory", () => {
    const parsed = parseArgs(["--allow-dirr", "/tmp"]);

    expect(parsed.allowedDirectories).toEqual([]);
    expect(parsed.unrecognized).toEqual(["--allow-dirr", "/tmp"]);
  });

  it("keeps parsing valid flags around an unrecognized one", () => {
    const parsed = parseArgs(["--verbose", "--allow-dir", "/tmp/recordings"]);

    expect(parsed.allowedDirectories).toEqual(["/tmp/recordings"]);
    expect(parsed.unrecognized).toEqual(["--verbose"]);
  });

  it("does not treat a flag-looking directory value as a flag", () => {
    // The value slot is taken verbatim, so a path is never re-parsed.
    const parsed = parseArgs(["--allow-dir", "--player-origin"]);

    expect(parsed.allowedDirectories).toEqual(["--player-origin"]);
    expect(parsed.unrecognized).toEqual([]);
  });
});
