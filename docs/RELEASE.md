# CoLive Release Checklist & Process 🚀

Follow this step-by-step checklist to prepare, verify, and publish a new version of CoLive.

---

## 1. Pre-Release Verification

Ensure working directory is clean and all tests and linter passes:

```bash
# 1. Pull latest master
git checkout master
git pull origin master

# 2. Clean build and lint
npm run clean
npm ci
npm run build
npm run lint

# 3. Run all test suites (unit, integration, and headless E2E)
npm test

# 4. Verify VSIX packaging
npm run package -w colive
```

Confirm that the output `.vsix` file in `packages/extension/` packages cleanly without unhandled dependencies or warnings.

---

## 2. Version Bump & Changelog

1. **Bump versions** consistently across all packages:
   - Root `package.json`
   - `packages/protocol/package.json`
   - `packages/server/package.json`
   - `packages/extension/package.json`

2. **Update `CHANGELOG.md`**:
   - Rename the `[Unreleased]` section to the new version `[X.Y.Z] - YYYY-MM-DD`.
   - Ensure all user-facing changes (Added, Changed, Deprecated, Removed, Fixed, Security) are documented.

3. **Commit the release preparation**:
   ```bash
   git add -A
   git commit -m "chore(release): prepare vX.Y.Z"
   ```

---

## 3. Git Tagging

Create an annotated git tag corresponding to the release version:

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin master
git push origin vX.Y.Z
```

---

## 4. Automated CI/CD Release

Pushing the `v*` tag triggers `.github/workflows/release.yml`:
1. The GitHub Action runs clean builds, tests, and builds the `.vsix` bundle.
2. A new GitHub Release is created attaching `colive-X.Y.Z.vsix`.
3. If `VSCE_PAT` secret is configured, publishes to [Visual Studio Marketplace](https://marketplace.visualstudio.com/).
4. If `OVSX_PAT` secret is configured, publishes to [Open VSX Registry](https://open-vsx.org/).

---

## 5. Post-Release Verification

1. Download the generated `.vsix` from GitHub Releases.
2. Test installation in a clean VS Code / Antigravity instance:
   ```bash
   code --install-extension colive-X.Y.Z.vsix
   ```
3. Verify that the extension activates, starts a session, and connects properly.
