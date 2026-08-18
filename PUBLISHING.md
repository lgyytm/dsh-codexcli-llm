# Publishing

## GitHub source installation

Push this repository, then tag a tested commit.

```sh
git tag v0.1.0
git push origin main --tags
```

Users can install a pinned source revision without npm publication:

```sh
dsh plugin --profile web add github:lgyytm/dsh-codexcli-llm#COMMIT
```

The package's prepare script builds the Host and Web artifacts during this installation.

## npm publication

Before running the Release workflow:

1. Confirm that dsh-codex is available on npm, or choose an owned scoped package name and update package.json, cordis.patch.yml, and the README commands together.
2. Create the package in npm and configure GitHub Actions trusted publishing for this repository, workflow .github/workflows/release.yml, and the npm-publish environment.
3. Create the npm-publish GitHub environment and require the reviewers appropriate for the package.
4. Dispatch **Release** with publish enabled from the version tag after the CI workflow has passed.

The workflow uses npm OIDC trusted publishing and requires no long-lived npm token.
