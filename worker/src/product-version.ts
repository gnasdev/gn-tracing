/**
 * Worker adapter: product version from worker/package.json (synced to root).
 */
import { requireProductVersion } from "../../packages/replay-core/src/product-version";
import packageJson from "../package.json";

export const PRODUCT_VERSION = requireProductVersion(packageJson.version, "worker");
