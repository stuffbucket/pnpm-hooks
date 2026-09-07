#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const checkOnly = process.argv[2] === "--check";

if (process.argv.length > (checkOnly ? 3 : 2)) {
  console.error("Usage: node apply-pnpm-tarball-policy.mjs [--check]");
  process.exit(2);
}

const lockfilePath = resolve("pnpm-lock.yaml");
let source;
let rules;
try {
  source = readFileSync(lockfilePath, "utf8");
  const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  const policy = manifest.pnpmTarballUrlPolicy;
  if (!policy || !Array.isArray(policy.rules) || policy.rules.length === 0) {
    throw new Error("package.json must define pnpmTarballUrlPolicy.rules");
  }
  rules = policy.rules.map((rule, index) => {
    try {
      new URL(rule.registry);
    } catch {
      throw new Error(`pnpmTarballUrlPolicy.rules[${index}].registry must be an absolute URL`);
    }
    if (
      !rule ||
      !Array.isArray(rule.includeTarballHostSuffixes) ||
      rule.includeTarballHostSuffixes.length === 0 ||
      rule.includeTarballHostSuffixes.some((suffix) => typeof suffix !== "string" || !suffix)
    ) {
      throw new Error(
        `pnpmTarballUrlPolicy.rules[${index}].includeTarballHostSuffixes must be a non-empty array`,
      );
    }
    if (rule.action !== undefined && rule.action !== "error" && rule.action !== "omit") {
      throw new Error(`pnpmTarballUrlPolicy.rules[${index}].action must be "error" or "omit"`);
    }
    if (
      rule.excludeTarballHostSuffixes !== undefined &&
      (!Array.isArray(rule.excludeTarballHostSuffixes) ||
        rule.excludeTarballHostSuffixes.some((suffix) => typeof suffix !== "string" || !suffix))
    ) {
      throw new Error(
        `pnpmTarballUrlPolicy.rules[${index}].excludeTarballHostSuffixes must be a string array`,
      );
    }
    return {
      action: rule.action || "error",
      excludes: rule.excludeTarballHostSuffixes || [],
      includes: rule.includeTarballHostSuffixes,
    };
  });
} catch (error) {
  console.error(`Cannot load lockfile policy: ${error.message}`);
  process.exit(1);
}

function hostMatchesSuffix(host, suffix) {
  const normalizedSuffix = suffix.toLowerCase().replace(/^\.+|\.+$/g, "");
  return host === normalizedSuffix || host.endsWith(`.${normalizedSuffix}`);
}

let removed = 0;
let blockedHost;
const repaired = source
  .split("\n")
  .map((line) => {
    const resolution = /^(\s+resolution:\s*\{)([^}]*)(\}\s*)$/.exec(line);
    if (!resolution) return line;

    const fields = resolution[2].split(/,\s*/);
    const kept = fields.filter((field) => {
      const tarball = /^tarball:\s*(.+)$/.exec(field);
      if (!tarball) return true;

      let host;
      try {
        host = new URL(tarball[1]).hostname.toLowerCase();
      } catch {
        return true;
      }
      const rule = rules.find(
        ({ includes, excludes }) =>
          includes.some((suffix) => hostMatchesSuffix(host, suffix)) &&
          !excludes.some((suffix) => hostMatchesSuffix(host, suffix)),
      );
      if (!rule) return true;
      if (rule.action === "error") {
        blockedHost = host;
        return true;
      }
      return false;
    });
    if (kept.length === fields.length) return line;

    removed += 1;
    return `${resolution[1]}${kept.join(", ")}${resolution[3]}`;
  })
  .join("\n");

if (blockedHost) {
  console.error(`pnpm-lock.yaml: blocked tarball host ${blockedHost}`);
  process.exit(1);
}

if (removed === 0) {
  console.log("pnpm-lock.yaml: clean");
  process.exit(0);
}

if (checkOnly) {
  console.error(`pnpm-lock.yaml: contains ${removed} configured tarball URL(s)`);
  process.exit(1);
}

writeFileSync(lockfilePath, repaired);
console.log(`pnpm-lock.yaml: omitted ${removed} configured tarball URL(s)`);
