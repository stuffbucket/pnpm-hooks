import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpmVersion = process.env.PNPM_VERSION;
assert.match(pnpmVersion || "", /^(11|12)\.\d+\.\d+$/);

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createTarball(directory) {
  const source = join(directory, "tarball-source");
  mkdirSync(join(source, "package"), { recursive: true });
  writeJson(join(source, "package", "package.json"), {
    name: "fixture-dep",
    version: "1.0.0",
    main: "index.js",
  });
  writeFileSync(join(source, "package", "index.js"), "module.exports = 'fixture';\n");
  const path = join(directory, "fixture-dep-1.0.0.tgz");
  const result = spawnSync("tar", ["-czf", path, "-C", source, "package"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(path);
}

async function startRegistry(directory) {
  const tarball = createTarball(directory);
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const server = createServer((request, response) => {
    if (request.url === "/fixture-dep") {
      const port = server.address().port;
      const metadata = {
        name: "fixture-dep",
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: "fixture-dep",
            version: "1.0.0",
            dist: {
              integrity,
              tarball: `http://localhost:${port}/fixture-dep/-/fixture-dep-1.0.0.tgz`,
            },
          },
        },
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(metadata));
      return;
    }
    if (request.url === "/fixture-dep/-/fixture-dep-1.0.0.tgz") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(tarball);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    url: `http://127.0.0.1:${server.address().port}/`,
  };
}

function run(command, arguments_, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stderr, stdout }));
  });
}

function policy(registry, overrides = {}) {
  return {
    rules: [{
      registry,
      includeTarballHostSuffixes: ["localhost"],
      action: "omit",
      ...overrides,
    }],
  };
}

function outputOf(result) {
  return `${result.stdout}\n${result.stderr}`.replace(/\s+/g, " ");
}

function createProject(directory, registry, manifest) {
  mkdirSync(directory, { recursive: true });
  copyFileSync(join(root, ".pnpmfile.cjs"), join(directory, ".pnpmfile.cjs"));
  writeFileSync(
    join(directory, ".npmrc"),
    `registry=${registry}\nfetch-retries=0\nfetch-timeout=5000\n`,
  );
  writeFileSync(
    join(directory, "pnpm-workspace.yaml"),
    "pmOnFail: ignore\npnpmfile: .pnpmfile.cjs\n",
  );
  writeJson(join(directory, "package.json"), {
    private: true,
    packageManager: `pnpm@${pnpmVersion}`,
    pnpmTarballUrlPolicy: policy(registry),
    ...manifest,
  });
}

async function install(directory, ...arguments_) {
  const result = await run("pnpm", ["install", "--ignore-scripts", ...arguments_], directory);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return readFileSync(join(directory, "pnpm-lock.yaml"), "utf8");
}

function assertOmitted(lockfile) {
  assert.match(lockfile, /integrity: sha512-/);
  assert.doesNotMatch(lockfile, /tarball: http:\/\/localhost:/);
}

test(`pnpm ${pnpmVersion}: plain project and policy mutations`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pnpm-policy-plain-"));
  const registry = await startRegistry(directory);
  try {
    createProject(directory, registry.url, {
      name: "plain-fixture",
      dependencies: { "fixture-dep": "1.0.0" },
    });
    assertOmitted(await install(directory, "--lockfile-only"));

    const manifestPath = join(directory, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.pnpmTarballUrlPolicy;
    writeJson(manifestPath, manifest);
    rmSync(join(directory, "pnpm-lock.yaml"));
    const missing = await run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], directory);
    assert.notEqual(missing.status, 0);
    assert.match(outputOf(missing), /must define pnpmTarballUrlPolicy\.rules/);

    manifest.pnpmTarballUrlPolicy = policy(registry.url, { action: undefined });
    writeJson(manifestPath, manifest);
    const blocked = await run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], directory);
    assert.notEqual(blocked.status, 0);
    assert.match(outputOf(blocked), /blocked tarball host localhost/);

    manifest.pnpmTarballUrlPolicy = policy(registry.url, {
      excludeTarballHostSuffixes: ["localhost"],
    });
    writeJson(manifestPath, manifest);
    const excluded = await install(directory, "--lockfile-only");
    assert.match(excluded, /tarball: http:\/\/localhost:/);
  } finally {
    await registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(`pnpm ${pnpmVersion}: shared-lockfile monorepo`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pnpm-policy-workspace-"));
  const registry = await startRegistry(directory);
  try {
    createProject(directory, registry.url, { name: "workspace-fixture" });
    writeFileSync(
      join(directory, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\npmOnFail: ignore\npnpmfile: .pnpmfile.cjs\n",
    );
    for (const name of ["app", "lib"]) {
      mkdirSync(join(directory, "packages", name), { recursive: true });
      writeJson(join(directory, "packages", name, "package.json"), {
        name: `@fixture/${name}`,
        version: "1.0.0",
        dependencies: { "fixture-dep": "1.0.0" },
      });
    }
    const lockfile = await install(directory, "--lockfile-only");
    assertOmitted(lockfile);
    assert.match(lockfile, /packages\/app:/);
    assert.match(lockfile, /packages\/lib:/);
  } finally {
    await registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(`pnpm ${pnpmVersion}: Turborepo install and build`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pnpm-policy-turbo-"));
  const registry = await startRegistry(directory);
  try {
    createProject(directory, registry.url, {
      name: "turbo-fixture",
      scripts: { build: "turbo run build" },
    });
    writeFileSync(
      join(directory, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\npmOnFail: ignore\npnpmfile: .pnpmfile.cjs\n",
    );
    writeJson(join(directory, "turbo.json"), {
      $schema: "https://turbo.build/schema.json",
      tasks: { build: { dependsOn: ["^build"], outputs: ["dist/**"] } },
    });
    for (const name of ["app", "lib"]) {
      mkdirSync(join(directory, "packages", name), { recursive: true });
      writeJson(join(directory, "packages", name, "package.json"), {
        name: `@fixture/${name}`,
        version: "1.0.0",
        scripts: {
          build: `node -e \"require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/${name}.txt','built')\"`,
        },
        dependencies: name === "app"
          ? { "@fixture/lib": "workspace:*", "fixture-dep": "1.0.0" }
          : { "fixture-dep": "1.0.0" },
      });
    }
    assertOmitted(await install(directory));
    const built = await run("turbo", ["run", "build"], directory);
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
    assert.equal(readFileSync(join(directory, "packages", "app", "dist", "app.txt"), "utf8"), "built");
    assert.equal(readFileSync(join(directory, "packages", "lib", "dist", "lib.txt"), "utf8"), "built");
  } finally {
    await registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});