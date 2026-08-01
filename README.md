# cachet-action

The public GitHub action that wires a CI job into the [cachet](https://pkg-cache.loopholelabs.io)
binary cache and pushes what the job builds. It exists as its own public repository because GitHub
does not let a public repository consume an action stored in a private one, and the cachet backend
repository is private — so a public consumer needs the action to live somewhere public.

The canonical source and the build that produces `post/dist/*.cjs` live in the private
`agx-runtime/cachet` repository under `action/`. This repository carries the published, pre-built
copy; a change is made in cachet and copied here, so any drift traces to that one source.

## What it does

The composite step installs Determinate Nix, mints the job's GitHub OIDC token, and writes the
cache as a substituter into the nix daemon's configuration, so the job substitutes from cachet.
Its nested post step runs only when the job succeeds: it diffs the store against a snapshot taken
before the job's own steps, drops paths cache.nixos.org already serves, signs the remainder with
the key the workflow supplied, uploads every NAR before its narinfo, and — on the default branch —
renews the project's garbage-collection lease.

## Usage

```yaml
permissions:
  contents: read
  id-token: write        # the job mints its own OIDC token; nothing is stored
steps:
  - uses: actions/checkout@v4
  - uses: agx-runtime/cachet-action@main
    with:
      roots: .#devShells.x86_64-linux.default
      signing-key: ${{ secrets.CACHET_SIGNING_KEY }}
  - run: nix flake check -L
```

`signing-key` is the one secret a consumer supplies — the org-level `CACHET_SIGNING_KEY`. The cache
URL, the OIDC audience, the default-branch ref, the upstream cache, and the cache's public signing
key are metadata defaults on the action, because they are deployment identity rather than secrets;
override any of them with the matching input for a different deployment.

Nix signs on the runner and the cache never holds a signing key, so a job needs `id-token: write`
to prove which repository it is, and nothing else. No R2 or cache credential is ever stored in a
consuming repository.

## What is not here

No secret and no credential. The signing key, the OIDC token, and the shared read token are all
runtime values a consuming workflow provides or GitHub mints for the job; none is baked into this
action. The values that are baked in — the cache URL, the audience, the default-branch ref, the
upstream URL, and the public half of the signing key — grant no access on their own, because a
write still requires an OIDC token GitHub will only mint for a repository in the accepted
organisations.
