# Releasing Kulmi

Kulmi releases are GitHub releases built from version tags. The release workflow checks Node.js 22 and 24, builds and smoke-tests the installable package, creates the npm tarball, and uploads a prebuilt `kulmi-node.tar.gz` plus its SHA-256 checksum for the installer.

## Release gate

Before tagging a release:

1. Confirm `package.json` and `src/core/version.ts` contain the intended version. `npm run check:version` enforces this.
2. Run `npm run check`.
3. Run `npm run test:live` with a low-balance test credential.
4. Run one read-only end-to-end task with the built CLI.
5. Run `npm audit --omit=dev --audit-level=high`.
6. Confirm `npm pack` installs into a clean temporary prefix and its `kulmi --version` output matches the release version.
7. Confirm `LICENSE` and the `package.json` `license` field match the intended open-source license before changing visibility to public.
8. Review the complete diff and commit it on `main`.

## Publish

For version `0.5.0`, create and push `v0.5.0` only after the `main` checks pass:

```sh
git tag -a v0.5.0 -m "v0.5.0"
git push origin main
git push origin v0.5.0
```

The workflow rejects a tag that does not match `package.json` or the built CLI version. A successful tagged run publishes:

- `kulmi-harness-0.5.0.tgz`
- `kulmi-node.tar.gz`
- `kulmi-node.tar.gz.sha256`
- generated GitHub release notes

## Verify the release

Install the published bundle in a clean shell:

```sh
curl -fsSL https://raw.githubusercontent.com/gabep7/kulmi-harness/main/install.sh | KULMI_INSTALL_REMOTE=1 sh
kulmi --version
kulmi doctor
```

For a private repository, use an authenticated GitHub CLI instead:

```sh
gh api --hostname github.com repos/gabep7/kulmi-harness/contents/install.sh \
  -H "Accept: application/vnd.github.raw+json" \
  | KULMI_INSTALL_REMOTE=1 sh
kulmi --version
kulmi doctor
```

Do not publish to npm until npm distribution is an explicit product decision. The current workflow creates an npm-compatible tarball but only uploads it to the GitHub release.
