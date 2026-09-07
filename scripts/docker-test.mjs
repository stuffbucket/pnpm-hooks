import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const turboVersion = "2.10.12";
const pnpmVersions = ["11.25.0", "12.1.0"];
const toolRegistry = "https://packagefeedproxy.microsoft.io/npm/";
const nodeImages = {
  amd64: "node:22-alpine@sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c",
  arm64: "node:22-alpine@sha256:1ef15d33d74602021f35ec64a4e72f4a21e2cfa68ebecd125fbe0c44af8f604a",
};

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/docker-test.mjs");
  process.exit(2);
}

function docker(arguments_, options = {}) {
  const result = spawnSync("docker", arguments_, {
    cwd: root,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw new Error(`Docker could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`docker ${arguments_[0]} failed with exit code ${result.status ?? "unknown"}`);
  }
  return result.stdout?.trim();
}

const architecture = docker(["version", "--format", "{{.Server.Arch}}"], { capture: true });
const nodeImage = nodeImages[architecture];
if (!nodeImage) throw new Error(`Unsupported Docker server architecture: ${architecture}`);

for (const pnpmVersion of pnpmVersions) {
  const temporary = mkdtempSync(join(tmpdir(), `pnpm-compat-${pnpmVersion}-`));
  const iidFile = join(temporary, "image-id");
  let imageId;
  try {
    console.log(`Building isolated pnpm ${pnpmVersion} compatibility image`);
    docker([
      "build",
      "--file", "Dockerfile.compat",
      "--iidfile", iidFile,
      "--build-arg", `NODE_IMAGE=${nodeImage}`,
      "--build-arg", `PNPM_VERSION=${pnpmVersion}`,
      "--build-arg", `TOOL_REGISTRY=${toolRegistry}`,
      "--build-arg", `TURBO_VERSION=${turboVersion}`,
      root,
    ]);
    imageId = readFileSync(iidFile, "utf8").trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error(`Invalid image ID: ${imageId}`);

    console.log(`Running isolated pnpm ${pnpmVersion} compatibility tests`);
    docker([
      "run",
      "--rm",
      "--init",
      "--read-only",
      "--network=none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--tmpfs", "/tmp:rw,nosuid,nodev",
      imageId,
    ]);
  } finally {
    if (imageId) spawnSync("docker", ["image", "rm", imageId], { cwd: root, stdio: "ignore" });
    rmSync(temporary, { recursive: true, force: true });
  }
}