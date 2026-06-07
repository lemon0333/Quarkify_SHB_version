# Release and Tag Policy

This repository uses SemVer-style release tags and GitHub Releases to make CLI
behavior changes traceable.

## Tag Format

Use annotated tags for public releases:

```bash
git tag -a v1.2.3 -m "Release v1.2.3"
```

Tag names must use the `vMAJOR.MINOR.PATCH` format:

- `v1.0.1` for a patch release
- `v1.1.0` for a minor release
- `v2.0.0` for a breaking major release

Pre-release tags may be used for validation builds:

- `v1.1.0-rc.1`
- `v1.1.0-beta.1`

Do not move or rewrite a pushed release tag. If a release is wrong, publish a
new patch or pre-release tag.

## Version Bumps

Use the smallest version bump that accurately describes the change:

- **Patch**: bug fixes, parser corrections, CI-only changes, documentation
  fixes, and behavior-preserving maintenance.
- **Minor**: new language support, new output folders or indexes, new CLI
  options, or backward-compatible output enhancements.
- **Major**: breaking output layout changes, removed config fields, incompatible
  CLI behavior, or parser changes that intentionally invalidate existing
  generated topology expectations.

## Release Prerequisites

Before creating a release tag:

1. Merge the release changes to `main`.
2. Confirm CI passes on `main`.
3. Run local verification if the release changes affect CLI behavior:

   ```bash
   npm test
   node --check quarkify.mjs
   ```

4. Confirm `package.json` version matches the planned tag.
5. Review the diff since the previous tag and prepare release notes.

## Release Notes

GitHub Release notes should include:

- notable parser, CLI, or output format changes
- migration notes for any generated folder name or config behavior changes
- fixed issues and pull requests
- verification performed before tagging

## Tag Ownership

Only maintainers should create and push release tags.

Use this flow:

```bash
git switch main
git pull --ff-only origin main
npm test
node --check quarkify.mjs
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

After pushing the tag, create a GitHub Release from that tag and paste the
release notes.
