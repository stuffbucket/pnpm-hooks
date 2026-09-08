import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, "apply-pnpm-tarball-policy.mjs");
const fixture = join(root, "test", "fixtures", "pnpm-lock.yaml");

function inFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "pnpm-hooks-"));
  copyFileSync(fixture, join(directory, "pnpm-lock.yaml"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      pnpmTarballUrlPolicy: {
        rules: [{
          registry: "https://packagefeedproxy.microsoft.io/npm/",
          includeTarballHostSuffixes: ["pkgs.visualstudio.com"],
          action: "omit",
        }],
      },
    }),
  );
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function execute(directory, ...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: directory,
    encoding: "utf8",
  });
}

async function withHookManifest(manifest, run) {
  const directory = mkdtempSync(join(tmpdir(), "pnpm-hooks-hook-"));
  const hookPath = join(directory, ".pnpmfile.cjs");
  const manifestPath = join(directory, "package.json");
  copyFileSync(join(root, ".pnpmfile.cjs"), hookPath);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  try {
    const hook = await import(pathToFileURL(hookPath));
    await run({ hook, manifestPath });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("repair removes only rotating Visual Studio shard tarball URLs", () => {
  inFixture((directory) => {
    const result = execute(directory);
    assert.equal(result.status, 0, result.stderr);

    const lockfile = readFileSync(join(directory, "pnpm-lock.yaml"), "utf8");
    assert.doesNotMatch(lockfile, /ms-feed-\d+\.pkgs\.visualstudio\.com/);
    assert.match(lockfile, /integrity: sha512-example/);
    assert.match(lockfile, /tarball: https:\/\/github\.com\/example\/archive\.tgz/);
  });
});

test("check reports the problem without changing the lockfile", () => {
  inFixture((directory) => {
    const path = join(directory, "pnpm-lock.yaml");
    const before = readFileSync(path, "utf8");
    const result = execute(directory, "--check");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /contains 2 configured tarball URL/);
    assert.equal(readFileSync(path, "utf8"), before);
  });
});

test("pnpm hook removes the same URLs from a parsed lockfile", async () => {
  await withHookManifest({
    pnpmTarballUrlPolicy: {
      rules: [{
        registry: "https://packagefeedproxy.microsoft.io/npm/",
        includeTarballHostSuffixes: ["pkgs.visualstudio.com"],
        action: "omit",
      }],
    },
  }, ({ hook }) => {
    const lockfile = {
      packages: {
        shard: {
          resolution: {
            integrity: "sha512-example",
            tarball: "https://ms-feed-12.pkgs.visualstudio.com/npm/pkg/-/pkg-1.0.0.tgz",
          },
        },
        fixed: {
          resolution: {
            tarball: "https://github.com/example/archive.tgz",
          },
        },
      },
    };

    hook.default.hooks.afterAllResolved(lockfile);
    assert.deepEqual(lockfile.packages.shard.resolution, { integrity: "sha512-example" });
    assert.equal(
      lockfile.packages.fixed.resolution.tarball,
      "https://github.com/example/archive.tgz",
    );
  });
});

test("pnpm hook defaults to blocking and gives exclusions precedence", async () => {
  const makeLockfile = () => ({
    packages: {
      shard: {
        resolution: {
          tarball: "https://ms-feed-12.pkgs.visualstudio.com/npm/pkg/-/pkg-1.0.0.tgz",
        },
      },
    },
  });

  await withHookManifest({}, ({ hook, manifestPath }) => {
    writeFileSync(
      manifestPath,
      JSON.stringify({
        pnpmTarballUrlPolicy: {
          rules: [{
            registry: "https://packagefeedproxy.microsoft.io/npm/",
            includeTarballHostSuffixes: ["pkgs.visualstudio.com"],
          }],
        },
      }),
    );
    assert.throws(
      () => hook.default.hooks.afterAllResolved(makeLockfile()),
      /blocked tarball host ms-feed-12\.pkgs\.visualstudio\.com/,
    );

    writeFileSync(
      manifestPath,
      JSON.stringify({
        pnpmTarballUrlPolicy: {
          rules: [{
            registry: "https://packagefeedproxy.microsoft.io/npm/",
            includeTarballHostSuffixes: ["pkgs.visualstudio.com"],
            excludeTarballHostSuffixes: ["ms-feed-12.pkgs.visualstudio.com"],
            action: "omit",
          }],
        },
      }),
    );
    const excluded = makeLockfile();
    hook.default.hooks.afterAllResolved(excluded);
    assert.match(excluded.packages.shard.resolution.tarball, /^https:/);

    writeFileSync(manifestPath, "{}");
    assert.throws(
      () => hook.default.hooks.afterAllResolved(makeLockfile()),
      /must define pnpmTarballUrlPolicy\.rules/,
    );
  });
});
