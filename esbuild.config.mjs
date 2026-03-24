import esbuild from "esbuild";
import fs from "fs/promises";
import path from "path";
import process from "process";

const production = process.argv[2] === "production";
const pluginDir = process.env.PLEX_SYNC_PLUGIN_DIR?.trim();
const outfile = pluginDir ? path.join(pluginDir, "main.js") : "main.js";
const rootDir = process.cwd();

async function isSamePath(left, right) {
  try {
    const [leftRealPath, rightRealPath] = await Promise.all([
      fs.realpath(left),
      fs.realpath(right)
    ]);
    return leftRealPath === rightRealPath;
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

async function syncStaticPluginFiles() {
  if (!pluginDir) {
    return;
  }

  await fs.mkdir(pluginDir, { recursive: true });
  await Promise.all(
    ["manifest.json", "styles.css", "versions.json"].map(async (fileName) => {
      const sourcePath = path.join(rootDir, fileName);
      const destinationPath = path.join(pluginDir, fileName);

      if (await isSamePath(sourcePath, destinationPath)) {
        return;
      }

      await fs.copyFile(sourcePath, destinationPath);
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
