import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(appRoot, "dist");

await mkdir(dist, { recursive: true });
await cp(
  resolve(appRoot, "zendesk", "manifest.json"),
  resolve(dist, "manifest.json"),
);
await rm(resolve(dist, "translations"), { force: true, recursive: true });
await cp(
  resolve(appRoot, "zendesk", "translations"),
  resolve(dist, "translations"),
  { recursive: true },
);
