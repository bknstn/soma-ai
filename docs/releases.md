# Versioning and releases

SOMA starts its release history at **0.1.0**, using the current implementation
as its baseline. The product is in early development; 1.0.0 will mark an
explicitly supported stable interface.

`package.json` is the single source of the SOMA product version. Both CLI entry
points report it without requiring Health OS, a runtime home, or credentials:

```sh
npm start -- --version
node src/runtime/cli.js --version
```

## Version policy

Use Semantic Versioning (`MAJOR.MINOR.PATCH`) and Git tags named `vX.Y.Z`.

- Before 1.0: use a minor bump for new features or breaking changes, and a patch
  bump for compatible fixes. Describe breaking changes and migration steps in
  the changelog. A patch must not silently break an existing interface.
- From 1.0: breaking changes bump major, compatible features bump minor, and
  compatible fixes bump patch.
- Prereleases use names such as `0.2.0-rc.1` and are marked as prereleases on
  GitHub. Release tags are immutable; corrections require a new version.
- The compatibility surface includes CLI arguments and JSON responses,
  configuration, skill contracts, and persisted SOMA state. Record required
  operator actions when any of these change.
- Health OS revisions, Hermes revisions, and JSON schema versions are separate
  from the SOMA product version. A product bump does not change their pins.

## Prepare a release

1. Collect changes under `[Unreleased]` in `CHANGELOG.md`. At release time, move
   them into `## [X.Y.Z] - YYYY-MM-DD`, leaving an empty `[Unreleased]` section.
2. Update the product version using `npm version patch --no-git-tag-version`
   (or `minor`, `major`, or an explicit version). For the first release, retain
   the existing `0.1.0`.
3. Run `npm run release:check` and `npm test`. Review the full release diff
   against `OPEN_SOURCE_REPO_SAFETY.md`, including release notes, then commit
   the intended release files. Resolve unrelated work separately. Release from
   a clean working tree after CI passes for that commit.
4. Create and push an annotated tag for the reviewed commit. For the first
   release:

   ```sh
   git tag -a v0.1.0 -m "SOMA 0.1.0"
   git push origin main
   git push origin v0.1.0
   ```

Pushing a `v*` tag runs the release workflow. It checks that the tag matches
`package.json`, validates dated release notes, and runs the full existing CI,
including synthetic integration and offline pinned-runtime checks. Only after
all checks pass does it create a GitHub Release using that version's changelog
entry. Prereleases do not replace the latest stable release.

For recovery after a failed workflow, rerun it for the same immutable tag. An
existing release is preserved. This workflow publishes source releases on
GitHub; npm registry publication is not configured.

## Install a release

GitHub's automatic source archives do not include the Hermes submodule contents.
Use a recursive clone at the desired tag, then follow the setup guide:

```sh
git clone --branch v0.1.0 --recurse-submodules YOUR_REPOSITORY_URL soma-ai
```
