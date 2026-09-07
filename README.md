# Control pnpm registry shard URLs

A small fix for pnpm lockfiles that fail with:

```text
ERR_PNPM_TARBALL_URL_MISMATCH
```

This happens when a registry proxy returns package tarballs from rotating hosts
such as:

```text
ms-feed-2.pkgs.visualstudio.com
ms-feed-17.pkgs.visualstudio.com
```

pnpm records the responding host in `pnpm-lock.yaml`. When the proxy later
returns the same package from another shard, pnpm rejects the old URL because it
no longer matches the registry metadata.

The public Microsoft package feed proxy is known to exhibit this behavior, but
the hook has no built-in registry or host policy:

```ini
registry=https://packagefeedproxy.microsoft.io/npm/
```

## Fix

From the root of the affected pnpm project:

```sh
curl -fsSL https://raw.githubusercontent.com/stuffbucket/pnpm-hooks/main/.pnpmfile.cjs -o .pnpmfile.cjs
curl -fsSL https://raw.githubusercontent.com/stuffbucket/pnpm-hooks/main/apply-pnpm-tarball-policy.mjs -o apply-pnpm-tarball-policy.mjs
node apply-pnpm-tarball-policy.mjs
pnpm install --lockfile-only
```

Add the hook to the workspace configuration:

```yaml
# pnpm-workspace.yaml
pnpmfile: .pnpmfile.cjs
```

Keep registry routing and credentials in `.npmrc`:

```ini
registry=https://packagefeedproxy.microsoft.io/npm/
```

Define the policy beside the packaging definition:

```json
{
	"pnpmTarballUrlPolicy": {
		"rules": [
			{
				"registry": "https://packagefeedproxy.microsoft.io/npm/",
				"includeTarballHostSuffixes": ["pkgs.visualstudio.com"],
				"action": "omit"
			}
		]
	}
}
```

Commit `.pnpmfile.cjs`, the repair script, `package.json`,
`pnpm-workspace.yaml`, and the updated `pnpm-lock.yaml`.

The repair command fixes an existing lockfile. The `.pnpmfile.cjs` hook prevents
pnpm from writing rotating shard URLs during future resolutions, including
lockfile updates made by dependency bots.

If CI must only check for the problem:

```sh
node apply-pnpm-tarball-policy.mjs --check
```

## Policy

The hook refuses to resolve without `package.json#pnpmTarballUrlPolicy.rules`.
Every rule must name the registry whose responses justify the policy. pnpm does
not expose effective registry routes to `afterAllResolved`, so this field is an
explicit, reviewable assertion rather than a route inferred by the hook.

`includeTarballHostSuffixes` matches a hostname or any of its subdomains.
`excludeTarballHostSuffixes` is optional and takes precedence. Matching is
case-insensitive and occurs on parsed URL hostnames, not arbitrary URL text.

The default action is `error`, which blocks a matching tarball URL. Set
`action` to `omit` only when the configured registry serves a stable URL that
pnpm can reconstruct after removing `resolution.tarball`.

Integrity hashes and all other tarball URLs are preserved. With the shard URL
absent, pnpm reconstructs the download URL from the configured registry's
current metadata.

The policy uses a top-level package field because `package.json` permits
namespaced tool metadata. pnpm owns the schema of `pnpm-workspace.yaml` and
rejects unknown fields inside registry declarations. Keeping the policy out of
pnpm's `registries` entries avoids relying on undocumented configuration.

## Workspaces

A workspace with one shared `pnpm-lock.yaml` has one root policy. A resolved
package snapshot is shared by all importers, so per-package tarball behavior
cannot differ inside that lockfile.

Separate workspace roots can carry different policies. A monorepo that sets
`sharedWorkspaceLockfile: false` can also give each lockfile root its own
hook and adjacent `package.json#pnpmTarballUrlPolicy`.

A lifecycle hook such as `postinstall` cannot repair this problem because pnpm
validates the recorded tarball URL before lifecycle scripts run.

## Privacy

The hook and repair script make no network requests and send no telemetry. They
read only pnpm's in-memory lockfile or the local `pnpm-lock.yaml` and report only
the number of removed URLs. They do not print package names, file paths,
credentials, environment variables, or lockfile contents.

The `curl` setup commands contact GitHub, and pnpm continues to contact the
registry configured by the project, as they normally would.

## Test

No dependencies are required:

```sh
npm test
```

The compatibility matrix builds separate containers for pnpm 11 and 12, then
runs plain-project, shared-lockfile monorepo, Turborepo, and policy-mutation
tests with runtime networking disabled:

```sh
npm run test:docker
```

Image construction downloads the exact pnpm and Turbo versions through
`https://packagefeedproxy.microsoft.io/npm/`; it does not contact
`registry.npmjs.org`. Registry retries and request duration are bounded so a
denied build dependency fails promptly.

Each fixture sets `pmOnFail: ignore` because the container image, rather than
pnpm's package-manager downloader, owns the exact pnpm version under test.

## Scope

The included example targets Visual Studio shard subdomains. The implementation
does not presume Microsoft, change registry routing, read credentials, or infer
relationships between unrelated registry and tarball hostnames.
