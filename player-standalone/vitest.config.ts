/**
 * Vitest for the SolidJS standalone player (jsdom).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../src/shared"),
      "@replay-core": path.resolve(__dirname, "../packages/replay-core/src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.ts", "shared/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.wrangler/**"],
  },
});
