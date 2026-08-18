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

## Current distribution

This repository is distributed directly from GitHub. It is not currently listed in a DSH plugin marketplace or published to npm.

Keep installation instructions pinned to a tested Git commit until a separate npm publishing decision is made.
