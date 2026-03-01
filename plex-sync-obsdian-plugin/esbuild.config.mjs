import esbuild from "esbuild";
import process from "process";

const production = process.argv[2] === "production";

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
  outfile: "main.js"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log("watching...");
}
