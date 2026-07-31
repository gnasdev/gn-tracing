/**
 * Re-export product-version route helpers from the single pure implementation
 * in `@gn-tracing/replay-core` (`packages/replay-core/src/route-version.mjs`).
 */
export {
  isProductRouteVersion,
  joinVersionedPath,
  pickWorkerOrigin,
  resolveVersionedWorkerEndpoints,
  type StrippedRouteVersion,
  stripRouteVersionPrefix,
  type WorkerEndpoints,
} from "../../packages/replay-core/src/route-version";
