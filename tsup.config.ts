import { defineConfig } from "tsup";

// tsup (esbuild) gives deterministic ESM + CJS output and .d.ts/.d.cts with
// one config, and has no runtime footprint in the published package.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  target: "node20",
  platform: "neutral",
  clean: true,
  sourcemap: false,
  treeshake: true,
});
