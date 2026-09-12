# Releasing Debridarr

Releases are container images published to GHCR. The package remains private
to prevent accidental publication to npm.

1. Choose the release version and update `package.json`, `package-lock.json`,
   the addon manifest version, `CHANGELOG.md`, and `docs/compatibility.md`.
2. Write the changelog for operators under Added, Changed, Fixed, and Upgrade
   notes. Include migrations, required configuration changes, and the backup
   command from [operations.md](operations.md).
3. Run `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test:coverage`,
   `npm run test:e2e`, and `npm run check:release -- vX.Y.Z`.
4. Merge the prepared release commit to `main`, then create and push the
   matching annotated tag: `git tag -a vX.Y.Z -m "Debridarr X.Y.Z"` followed
   by `git push origin vX.Y.Z`.
5. Wait for the tag workflow to build and publish both container architectures.
   Verify the GHCR tag and `/health/ready` on a fresh deployment before
   announcing the release.

Never move or reuse a published version tag. Prepare a new patch release if a
published image needs correction.
