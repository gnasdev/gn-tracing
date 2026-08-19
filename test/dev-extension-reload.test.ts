import { afterEach, describe, expect, it } from "vitest";
import { createDevExtensionReloadCoordinator } from "../scripts/dev-extension-reload.mjs";

describe("dev extension reload coordinator", () => {
  let coordinator: Awaited<ReturnType<typeof createDevExtensionReloadCoordinator>> | null = null;

  afterEach(async () => {
    await coordinator?.stop();
    coordinator = null;
  });

  it("notifies only the rebuilt browser target", async () => {
    coordinator = await createDevExtensionReloadCoordinator({ port: 0 });
    const { origin } = await coordinator.start();

    const chromeWait = fetch(`${origin}/wait?target=chrome&revision=0`).then((response) =>
      response.json(),
    );
    const firefoxWait = fetch(`${origin}/wait?target=firefox&revision=0`).then((response) =>
      response.json(),
    );

    await fetch(`${origin}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "chrome" }),
    });

    await expect(chromeWait).resolves.toMatchObject({ target: "chrome", revision: "1" });
    await expect(
      Promise.race([
        firefoxWait.then(() => "notified"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 25)),
      ]),
    ).resolves.toBe("pending");
  });

  it("reports its identity and rejects invalid reload targets", async () => {
    coordinator = await createDevExtensionReloadCoordinator({ port: 0 });
    const { origin } = await coordinator.start();

    await expect(fetch(`${origin}/health`).then((response) => response.json())).resolves.toEqual({
      ok: true,
      service: "gn-tracing-dev-extension-reload",
    });
    await expect(
      fetch(`${origin}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "safari" }),
      }).then((response) => response.status),
    ).resolves.toBe(400);
  });

  it("rejects reload requests issued by website origins", async () => {
    coordinator = await createDevExtensionReloadCoordinator({ port: 0 });
    const { origin } = await coordinator.start();

    await expect(
      fetch(`${origin}/notify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://untrusted.example",
        },
        body: JSON.stringify({ target: "chrome" }),
      }).then((response) => response.status),
    ).resolves.toBe(403);
  });
});
