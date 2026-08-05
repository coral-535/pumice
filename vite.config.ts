import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    entry: {
      index: "src/index.ts",
      core: "src/core/index.ts",
      "daemon-cli": "src/daemon-cli.ts",
    },
    dts: {
      tsgo: true,
    },
    exports: false,
    format: ["esm"],
    sourcemap: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
