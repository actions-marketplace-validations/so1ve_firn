import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["action/main.ts", "action/post.ts"],
  outDir: "action/dist",
  platform: "node",
  target: "node24",
  format: "esm",
  dts: false,
  minify: true,
  clean: true,
  outputOptions: {
    chunkFileNames: "[name].mjs",
  },
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: false,
  },
});
