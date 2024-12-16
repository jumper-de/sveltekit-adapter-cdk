import { Adapter } from "@sveltejs/kit";
import { readFileSync } from "fs";
import { rollup } from "rollup";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import { fileURLToPath } from "url";

export interface AdapterProps {
  out?: string;
  precompress?: boolean;
  envPrefix?: string;
}

export default function (props: AdapterProps) {
  const { out = "./dist", precompress = false, envPrefix = "" } = props;

  return {
    name: "@flit/sveltekit-adapter-cdk",
    async adapt(builder) {
      const tmp = builder.getBuildDirectory("adapter-cdk");

      builder.rimraf(out);
      builder.rimraf(tmp);
      builder.mkdirp(tmp);

      builder.log.minor("Copying assets");
      builder.writeClient(`${out}/client${builder.config.kit.paths.base}`);
      builder.writePrerendered(
        `${out}/prerendered${builder.config.kit.paths.base}`,
      );

      if (precompress) {
        builder.log.minor("Compressing assets");
        await Promise.all([
          builder.compress(`${out}/client`),
          builder.compress(`${out}/prerendered`),
        ]);
      }

      builder.log.minor("Building server");

      builder.writeServer(`${tmp}/server`);

      builder.copy(
        fileURLToPath(new URL("./cdk.js", import.meta.url).href),
        `${out}/index.js`,
        {
          replace: {
            MANIFEST_DEST: "./server/manifest.js",
          },
        },
      );

      builder.copy(
        fileURLToPath(new URL("./cdk.d.ts", import.meta.url).href),
        `${out}/index.d.ts`,
        {
          replace: {
            MANIFEST_DEST: "./server/manifest.js",
          },
        },
      );

      builder.copy(
        fileURLToPath(new URL("./handler.cjs.js", import.meta.url).href),
        `${tmp}/index.cjs.js`,
        {
          replace: {
            ENV_DEST: "./env.js",
            MANIFEST_DEST: "./server/manifest.js",
            SERVER_DEST: "./server/index.js",
            SHIMS_DEST: "./shims.js",
            ENV_PREFIX_DEST: JSON.stringify(envPrefix),
          },
        },
      );

      builder.copy(
        fileURLToPath(new URL("./handler.esm.js", import.meta.url).href),
        `${tmp}/index.esm.js`,
        {
          replace: {
            ENV_DEST: "./env.js",
            MANIFEST_DEST: "./server/manifest.js",
            SERVER_DEST: "./server/index.js",
            SHIMS_DEST: "./shims.js",
            ENV_PREFIX_DEST: JSON.stringify(envPrefix),
          },
        },
      );

      const pkg = JSON.parse(readFileSync("package.json", "utf8"));

      const bundle = await rollup({
        input: {
          "index.cjs": `${tmp}/index.cjs.js`,
          "index.esm": `${tmp}/index.esm.js`,
          manifest: `${tmp}/server/manifest.js`,
        },
        output: {
          sourcemap: false,
        },
        external: [
          ...Object.keys(pkg.dependencies || {}).map(
            (d) => new RegExp(`^${d}(\\/.*)?$`),
          ),
        ],
        plugins: [
          nodeResolve({ preferBuiltins: true, exportConditions: ["node"] }),
          commonjs({ strictRequires: true }),
          json(),
        ],
      });

      await bundle.write({
        dir: `${out}/server`,
        format: "esm",
        sourcemap: true,
        chunkFileNames: "chunks/[name]-[hash].js",
      });
    },
  } satisfies Adapter;
}
