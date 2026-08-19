import { parseReleaseRegistry } from "../../../packages/release-registry/src/index.ts";
import { handleDriveProxyRequest } from "../../../player/shared/proxy/drive-download.js";
import { handleDropboxProxyRequest } from "../../../player/shared/proxy/dropbox-download.js";
import registryJson from "../../../releases/registry.json";
import { createPlayerRouter, type PlayerArtifactStore } from "./index";

interface Env {
  PLAYER_RELEASES: PlayerArtifactStore;
  LATEST_RELEASE_VERSION?: string;
}

const registry = parseReleaseRegistry(registryJson);

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return createPlayerRouter({
      registry,
      artifactStore: env.PLAYER_RELEASES,
      proxies: {
        drive: handleDriveProxyRequest,
        dropbox: handleDropboxProxyRequest,
      },
      legacyVersion: env.LATEST_RELEASE_VERSION,
    }).fetch(request);
  },
};
