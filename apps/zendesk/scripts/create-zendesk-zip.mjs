import { copyFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("@zendesk/zcli-apps/package.json"));
const { createAppPkg } = require(
  join(packageRoot, "dist", "lib", "package.js"),
);

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(appRoot, "dist");
const manifest = JSON.parse(
  await readFile(resolve(dist, "manifest.json"), "utf8"),
);
const generatedPath = await createAppPkg(dist);
const artifactPath = resolve(
  dist,
  "tmp",
  `Resolve-v${manifest.version}-zendesk.zip`,
);

await copyFile(generatedPath, artifactPath);
stdout.write(`${artifactPath}\n`);
