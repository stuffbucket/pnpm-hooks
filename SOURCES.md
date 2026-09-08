# Sources and integrity notes

## Lockfile integrity

This workspace uses the public, tokenless Microsoft package feed proxy as its
canonical npm-compatible registry:

```text
https://packagefeedproxy.microsoft.io/npm/
```

The proxy can return package tarballs from rotating `pkgs.visualstudio.com`
shards. pnpm records the responding tarball host in a lockfile, so a later shard
rotation can trigger `ERR_PNPM_TARBALL_URL_MISMATCH` even when the package and
its integrity hash are unchanged.

The policy in `.pnpmfile.cjs` removes only configured shard tarball URLs. It
preserves every `resolution.integrity` value so pnpm continues to verify package
bytes. The adjacent `package.json#pnpmTarballUrlPolicy` field is the explicit,
reviewable assertion that allows this behavior.

The registry metadata for pnpm 11.25.0 exposes a SHA-1 `dist.shasum` but not a
`dist.integrity` value. This repository independently pins the downloaded
5,116,259-byte tarball with SHA-512 in `package.json`, `mise.toml`, and
`mise.lock`; CI verifies that digest before extraction.

To repair an existing lockfile, run:

```sh
node apply-pnpm-tarball-policy.mjs
pnpm install --lockfile-only
```

To check without changing the lockfile, run:

```sh
node apply-pnpm-tarball-policy.mjs --check
```

See `README.md` for the policy schema, scope, and setup instructions.
