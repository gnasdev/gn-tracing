/**
 * Player wires list filtering through the same getNetworkFilterType as unit tests.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getNetworkFilterType } from "./network-filter-type";

const playerJs = readFileSync(
  resolve(import.meta.dirname, "../../player-standalone/public/player.js"),
  "utf8",
);
const coreEntry = readFileSync(
  resolve(import.meta.dirname, "../../player-standalone/core-entry.ts"),
  "utf8",
);

describe("player network filter wiring", () => {
  it("core-entry exports getNetworkFilterType on network namespace", () => {
    expect(coreEntry).toMatch(/getNetworkFilterType/);
    expect(coreEntry).toMatch(/export const network/);
  });

  it("player getNetworkFilterType delegates to gnCore.network", () => {
    expect(playerJs).toMatch(/gnCore\.network/);
    expect(playerJs).toMatch(/core\.getNetworkFilterType/);
  });

  it("acceptance cases still hold on the shared classifier the player uses", () => {
    expect(
      getNetworkFilterType({
        resourceType: "Other",
        url: "https://cdn.example.com/app.chunk.js",
        mimeType: "application/javascript",
      }),
    ).toBe("js");
    expect(
      getNetworkFilterType({
        resourceType: "Fetch",
        url: "https://api.example.com/module.js",
        mimeType: "application/javascript",
      }),
    ).toBe("fetch");
    expect(
      getNetworkFilterType({
        resourceType: "Script",
        url: "https://cdn.example.com/app.js",
      }),
    ).toBe("js");
    expect(
      getNetworkFilterType({
        url: "https://cdn.example.com/app.js.map",
      }),
    ).toBe("other");
  });
});
