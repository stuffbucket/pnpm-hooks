import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compatibilityLabel,
  compatibilityRoleLabel,
  compatibilityRunLabel,
  pnpmVersions,
} from "./docker-clean.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const turboVersion = "2.10.12";
const toolRegistry = "https://packagefeedproxy.microsoft.io/npm/";
const runId = randomUUID();
const leaseName = `pnpm-hooks-compat-lease-${runId}`;
const nodeImages = {
  amd64: "node:22-alpine@sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c",
  arm64: "node:22-alpine@sha256:1ef15d33d74602021f35ec64a4e72f4a21e2cfa68ebecd125fbe0c44af8f604a",
};

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/docker-test.mjs");
  process.exit(2);
}

function docker(arguments_, options = {}) {
  const operation = [
    "docker",
    ...arguments_.slice(0, arguments_[0] === "buildx" ? 2 : 1),
  ].join(" ");
  const result = spawnSync("docker", arguments_, {
    cwd: root,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw new Error(`${operation} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${operation} failed with exit code ${result.status ?? "unknown"}`);
  }
  return result.stdout?.trim();
}

function removeDockerResource(resource, name) {
  const removal = spawnSync(
    "docker",
    [resource, "rm", ...(resource === "container" ? ["--force"] : []), name],
    { cwd: root, encoding: "utf8", stdio: "pipe" },
  );
  if (removal.error) {
    return new Error(`Could not remove ${resource} ${name}: ${removal.error.message}`);
  }
  if (removal.status === 0) return undefined;

  const detail = `${removal.stdout}\n${removal.stderr}`.trim();
  return /No such (?:object|container|image)/i.test(detail)
    ? undefined
    : new Error(`Could not remove ${resource} ${name}: ${detail}`);
}

const architecture = docker(["version", "--format", "{{.Server.Arch}}"], { capture: true });
const nodeImage = nodeImages[architecture];
if (!nodeImage) throw new Error(`Unsupported Docker server architecture: ${architecture}`);
try {
  docker(["buildx", "version"], { capture: true });
} catch (error) {
  throw new Error(
    "Docker Buildx is required. Run `mise install --locked` and `mise run setup-buildx`.",
    { cause: error },
  );
}

docker([
  "run",
  "--detach",
  "--name", leaseName,
  "--label", `${compatibilityLabel}=true`,
  "--label", `${compatibilityRunLabel}=${runId}`,
  "--label", `${compatibilityRoleLabel}=lease`,
  "--init",
  "--read-only",
  "--network=none",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  nodeImage,
  "node",
  "-e",
  "setInterval(() => {}, 2 ** 30)",
], { capture: true });

let matrixSucceeded = false;
try {
  for (const pnpmVersion of pnpmVersions) {
    const temporary = mkdtempSync(join(tmpdir(), `pnpm-compat-${pnpmVersion}-`));
    const iidFile = join(temporary, "image-id");
    const resourceSuffix = `${pnpmVersion}-${runId}`;
    const imageTag = `pnpm-hooks-compat:${resourceSuffix}`;
    const containerName = `pnpm-hooks-compat-${resourceSuffix}`;
    let testSucceeded = false;
    try {
      console.log(`Building isolated pnpm ${pnpmVersion} compatibility image`);
      docker([
        "buildx",
        "build",
        "--load",
        "--platform", `linux/${architecture}`,
        "--tag", imageTag,
        "--label", `${compatibilityLabel}=true`,
        "--label", `${compatibilityRunLabel}=${runId}`,
        "--label", `${compatibilityRoleLabel}=test`,
        "--file", "Dockerfile.compat",
        "--iidfile", iidFile,
        "--build-arg", `NODE_IMAGE=${nodeImage}`,
        "--build-arg", `PNPM_VERSION=${pnpmVersion}`,
        "--build-arg", `TOOL_REGISTRY=${toolRegistry}`,
        "--build-arg", `TURBO_VERSION=${turboVersion}`,
        root,
      ]);
      const imageId = readFileSync(iidFile, "utf8").trim();
      if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error(`Invalid image ID: ${imageId}`);

      console.log(`Running isolated pnpm ${pnpmVersion} compatibility tests`);
      docker([
        "run",
        "--name", containerName,
        "--label", `${compatibilityLabel}=true`,
        "--label", `${compatibilityRunLabel}=${runId}`,
        "--label", `${compatibilityRoleLabel}=test`,
        "--rm",
        "--init",
        "--read-only",
        "--network=none",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs", "/tmp:rw,nosuid,nodev",
        imageId,
      ]);
      testSucceeded = true;
    } finally {
      const cleanupErrors = [
        removeDockerResource("container", containerName),
        removeDockerResource("image", imageTag),
      ].filter(Boolean);
      try {
        rmSync(temporary, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }

      if (cleanupErrors.length > 0) {
        if (testSucceeded) {
          throw new AggregateError(
            cleanupErrors,
            `Could not clean up pnpm ${pnpmVersion} test resources`,
          );
        }
        for (const error of cleanupErrors) {
          console.warn(`Cleanup after test failure: ${error.message}`);
        }
      }
    }
  }
  matrixSucceeded = true;
} finally {
  const leaseError = removeDockerResource("container", leaseName);
  if (leaseError) {
    if (matrixSucceeded) throw leaseError;
    console.warn(`Cleanup after test failure: ${leaseError.message}`);
  }
}
