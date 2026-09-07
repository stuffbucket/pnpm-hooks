const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/*
Add an explicit policy to the package.json beside this file. For Microsoft's
public proxy, the configuration is:

  "pnpmTarballUrlPolicy": {
    "rules": [{
      "registry": "https://packagefeedproxy.microsoft.io/npm/",
      "includeTarballHostSuffixes": ["pkgs.visualstudio.com"],
      "action": "omit"
    }]
  }
*/

function normalizedUrl(value, field) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.href;
  } catch {
    throw new Error(`pnpmfile: ${field} must be an absolute URL`);
  }
}

function hostMatchesSuffix(host, suffix) {
  const normalizedSuffix = suffix.toLowerCase().replace(/^\.+|\.+$/g, "");
  return host === normalizedSuffix || host.endsWith(`.${normalizedSuffix}`);
}

function readRules() {
  const manifest = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
  const policy = manifest.pnpmTarballUrlPolicy;
  if (!policy || !Array.isArray(policy.rules) || policy.rules.length === 0) {
    throw new Error("pnpmfile: package.json must define pnpmTarballUrlPolicy.rules");
  }

  return policy.rules.map((rule, index) => {
    const field = `pnpmTarballUrlPolicy.rules[${index}]`;
    if (!rule || typeof rule !== "object") throw new Error(`pnpmfile: ${field} must be an object`);

    normalizedUrl(rule.registry, `${field}.registry`);
    if (
      !Array.isArray(rule.includeTarballHostSuffixes) ||
      rule.includeTarballHostSuffixes.length === 0 ||
      rule.includeTarballHostSuffixes.some((suffix) => typeof suffix !== "string" || !suffix)
    ) {
      throw new Error(`pnpmfile: ${field}.includeTarballHostSuffixes must be a non-empty string array`);
    }
    if (
      rule.excludeTarballHostSuffixes !== undefined &&
      (!Array.isArray(rule.excludeTarballHostSuffixes) ||
        rule.excludeTarballHostSuffixes.some((suffix) => typeof suffix !== "string" || !suffix))
    ) {
      throw new Error(`pnpmfile: ${field}.excludeTarballHostSuffixes must be a string array`);
    }
    if (rule.action !== undefined && rule.action !== "error" && rule.action !== "omit") {
      throw new Error(`pnpmfile: ${field}.action must be "error" or "omit"`);
    }

    return {
      action: rule.action || "error",
      excludes: rule.excludeTarballHostSuffixes || [],
      includes: rule.includeTarballHostSuffixes,
    };
  });
}

function afterAllResolved(lockfile) {
  const activeRules = readRules();

  const packages = lockfile && lockfile.packages;
  if (!packages || typeof packages !== "object") return lockfile;

  let removed = 0;
  for (const entry of Object.values(packages)) {
    const resolution = entry && entry.resolution;
    if (!resolution || typeof resolution.tarball !== "string") continue;

    let tarball;
    try {
      tarball = new URL(resolution.tarball);
    } catch {
      continue;
    }
    const host = tarball.hostname.toLowerCase();
    const rule = activeRules.find(
      ({ includes, excludes }) =>
        includes.some((suffix) => hostMatchesSuffix(host, suffix)) &&
        !excludes.some((suffix) => hostMatchesSuffix(host, suffix)),
    );
    if (!rule) continue;
    if (rule.action === "error") throw new Error(`pnpmfile: blocked tarball host ${host}`);

    delete resolution.tarball;
    removed += 1;
  }

  if (removed > 0) console.log(`pnpmfile: omitted ${removed} configured tarball URL(s)`);
  return lockfile;
}

module.exports = { hooks: { afterAllResolved } };
