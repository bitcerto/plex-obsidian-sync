import esbuild from "esbuild";
import fs from "fs/promises";
import path from "path";
import process from "process";

const production = process.argv[2] === "production";
const pluginDir = process.env.PLEX_SYNC_PLUGIN_DIR?.trim();
const outfile = pluginDir ? path.join(pluginDir, "main.js") : "main.js";

async function syncStaticPluginFiles() {
  if (!pluginDir) {
    return;
  }

  await fs.mkdir(pluginDir, { recursive: true });
  await Promise.all(
    ["manifest.json", "styles.css", "versions.json"].map(async (fileName) => {
      await fs.copyFile(fileName, path.join(pluginDir, fileName));
    })
  );
}

const context = await esbuild.context({
  banner: {
    js: "/* eslint-disable */"
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile,
  plugins: [
    {
      name: "sync-static-plugin-files",
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length > 0) {
            return;
          }
          await syncStaticPluginFiles();
        });
      }
    }
  ]
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await syncStaticPluginFiles();
  await context.watch();
  if (pluginDir) {
    console.log(`watching plugin in ${pluginDir}...`);
  } else {
    console.log("watching...");
  }
}
