import { parseReleaseRegistry } from "../../../packages/release-registry/src/index.ts";
import registryJson from "../../../releases/registry.json";
import { createWorkerVersionRouter, type VersionWorkerService } from "./index";

interface Env {
  LATEST_RELEASE_VERSION?: string;
  [binding: string]: VersionWorkerService | string | undefined;
}

const registry = parseReleaseRegistry(registryJson);

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const bindings: Record<string, VersionWorkerService | undefined> = {};
    for (const release of registry.releases) {
      const candidate = env[release.worker.bindingName];
      if (candidate && typeof candidate !== "string" && "fetch" in candidate) {
        bindings[release.worker.bindingName] = candidate;
      }
    }
    return createWorkerVersionRouter({
      registry,
      bindings,
      legacyVersion: env.LATEST_RELEASE_VERSION,
    }).fetch(request);
  },
};
