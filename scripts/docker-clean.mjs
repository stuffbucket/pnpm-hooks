import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const compatibilityLabel = "io.github.stuffbucket.pnpm-hooks.compat";
export const compatibilityRunLabel = `${compatibilityLabel}.run`;
export const compatibilityRoleLabel = `${compatibilityLabel}.role`;
export const pnpmVersions = Object.freeze(["11.25.0", "12.1.0"]);

const uuidSource = "[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}";
const versionSource = pnpmVersions.map((version) => version.replaceAll(".", "\\.")).join("|");
const containerPattern = new RegExp(
  `^pnpm-hooks-compat-(?<version>${versionSource})-(?<runId>${uuidSource})$`,
);
const imagePattern = new RegExp(
  `^pnpm-hooks-compat:(?<version>${versionSource})-(?<runId>${uuidSource})$`,
);
const leasePattern = new RegExp(`^pnpm-hooks-compat-lease-(?<runId>${uuidSource})$`);

function docker(arguments_, options = {}) {
  const result = spawnSync("docker", arguments_, {
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
  });
  const operation = ["docker", ...arguments_.slice(0, 2)].join(" ");
  if (result.error) throw new Error(`${operation} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = options.capture ? `: ${result.stderr.trim()}` : "";
    throw new Error(`${operation} failed with exit code ${result.status ?? "unknown"}${detail}`);
  }
  return result.stdout?.trim();
}

function hasExpectedRunLabel(resource, name, runId) {
  const result = spawnSync(
    "docker",
    [resource, "inspect", "--format", `{{index .Config.Labels "${compatibilityRunLabel}"}}`, name],
    { encoding: "utf8", stdio: "pipe" },
  );
  if (result.error) {
    throw new Error(`docker ${resource} inspect could not start: ${result.error.message}`);
  }
  if (result.status === 0) return result.stdout.trim() === runId;

  const detail = `${result.stdout}\n${result.stderr}`.trim();
  if (/No such (?:object|container|image)/i.test(detail)) return false;
  throw new Error(
    `docker ${resource} inspect failed with exit code ${result.status ?? "unknown"}: ${detail}`,
  );
}

function records(output, pattern, resource) {
  if (!output) return [];
  const matches = [];
  for (const rawLine of output.split("\n")) {
    const name = rawLine.trimEnd();
    const match = name.match(pattern);
    if (match && hasExpectedRunLabel(resource, name, match.groups.runId)) matches.push(name);
  }
  return [...new Set(matches)];
}

function matchingContainers(options = {}) {
  const arguments_ = ["container", "ls"];
  if (!options.runningOnly) arguments_.push("--all");
  arguments_.push(
    "--filter", `label=${compatibilityLabel}=true`,
    "--filter", `label=${compatibilityRoleLabel}=test`,
    "--filter", "name=pnpm-hooks-compat-",
    "--format", "{{.Names}}",
  );
  return records(docker(arguments_, { capture: true }), containerPattern, "container");
}

function matchingImages() {
  const output = docker([
    "image",
    "ls",
    "--all",
    "--filter", `label=${compatibilityLabel}=true`,
    "--filter", `label=${compatibilityRoleLabel}=test`,
    "--filter", "reference=pnpm-hooks-compat:*",
    "--format", "{{.Repository}}:{{.Tag}}",
  ], { capture: true });
  return records(output, imagePattern, "image");
}

function matchingLeases() {
  const output = docker([
    "container",
    "ls",
    "--all",
    "--filter", `label=${compatibilityLabel}=true`,
    "--filter", `label=${compatibilityRoleLabel}=lease`,
    "--filter", "name=pnpm-hooks-compat-lease-",
    "--format", "{{.Names}}",
  ], { capture: true });
  return records(output, leasePattern, "container");
}

const removalWaitState = new Int32Array(new SharedArrayBuffer(4));

function waitForDockerResourceRemoval(resource, name) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = spawnSync("docker", [resource, "inspect", name], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.error) {
      throw new Error(`docker ${resource} inspect could not start: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = `${result.stdout}\n${result.stderr}`.trim();
      if (/No such (?:object|container|image)/i.test(detail)) return;
      throw new Error(
        `docker ${resource} inspect failed with exit code ${result.status ?? "unknown"}: ${detail}`,
      );
    }
    Atomics.wait(removalWaitState, 0, 0, 100);
  }
  throw new Error(`Timed out waiting for ${resource} ${name} removal to finish`);
}

function removeDockerResource(resource, name, options = {}) {
  const result = spawnSync(
    "docker",
    [resource, "rm", ...(options.force ? ["--force"] : []), name],
    { encoding: "utf8", stdio: "pipe" },
  );
  if (result.error) {
    throw new Error(`docker ${resource} rm could not start: ${result.error.message}`);
  }
  if (result.status === 0) return true;

  const detail = `${result.stdout}\n${result.stderr}`.trim();
  if (/No such (?:object|container|image)/i.test(detail)) return false;
  if (/removal .* is already in progress/i.test(detail)) {
    waitForDockerResourceRemoval(resource, name);
    return false;
  }
  throw new Error(
    `docker ${resource} rm failed with exit code ${result.status ?? "unknown"}: ${detail}`,
  );
}

function assertNoActiveMatrix() {
  const leases = matchingLeases();
  if (leases.length > 0) {
    throw new Error(
      `${leases.length} compatibility matrix lease(s) are active; wait for them or rerun with --force.`,
    );
  }
  const running = matchingContainers({ runningOnly: true });
  if (running.length > 0) {
    throw new Error(
      `${running.length} compatibility container(s) are running; stop the matrix or rerun with --force.`,
    );
  }
}

export function cleanDockerResources(options = {}) {
  if (!options.force) assertNoActiveMatrix();
  const leases = matchingLeases();
  const containers = matchingContainers();
  const images = matchingImages();
  if (!options.force) assertNoActiveMatrix();

  const errors = [];
  let removedContainers = 0;
  for (const container of [...containers, ...(options.force ? leases : [])]) {
    try {
      if (removeDockerResource("container", container, options)) removedContainers += 1;
    } catch (error) {
      errors.push(error);
    }
  }

  let removedImages = 0;
  for (const image of images) {
    try {
      if (removeDockerResource("image", image, options)) removedImages += 1;
    } catch (error) {
      errors.push(error);
    }
  }

  console.log(`Removed ${removedContainers} compatibility container(s) and ${removedImages} image(s).`);
  if (errors.length > 0) throw new AggregateError(errors, "Some compatibility resources remain");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rawArguments = process.argv.slice(2);
  const arguments_ = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
  if (arguments_.some((argument) => argument !== "--force") || arguments_.length > 1) {
    console.error("Usage: node scripts/docker-clean.mjs [--force]");
    process.exitCode = 2;
  } else {
    try {
      cleanDockerResources({ force: arguments_[0] === "--force" });
    } catch (error) {
      console.error(error.message);
      if (error instanceof AggregateError) {
        for (const cause of error.errors) console.error(`- ${cause.message}`);
      }
      process.exitCode = 1;
    }
  }
}
