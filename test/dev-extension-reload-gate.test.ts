import { describe, expect, it, vi } from "vitest";
import { createDevExtensionReloadGate } from "../scripts/dev-extension-reload-gate.mjs";

describe("dev extension reload gate", () => {
  it("notifies only after every bundling context is successful", () => {
    const notify = vi.fn();
    const gate = createDevExtensionReloadGate(notify);
    gate.register("service-worker");
    gate.register("ui");
    gate.register("content");

    gate.report("service-worker", false);
    gate.report("ui", false);
    expect(notify).not.toHaveBeenCalled();

    gate.report("content", false);
    expect(notify).toHaveBeenCalledOnce();

    gate.begin("ui");
    gate.report("service-worker", false);
    expect(notify).toHaveBeenCalledOnce();

    gate.report("ui", false);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("blocks static and source reloads while any bundling context has errors", () => {
    const notify = vi.fn();
    const gate = createDevExtensionReloadGate(notify);
    gate.register("service-worker");
    gate.register("ui");

    gate.report("service-worker", false);
    gate.report("ui", true);
    gate.notifyStaticAssets();
    expect(notify).not.toHaveBeenCalled();

    gate.report("ui", false);
    expect(notify).toHaveBeenCalledOnce();
  });
});
