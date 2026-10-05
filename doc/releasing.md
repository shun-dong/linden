# Local development and product releases

The `dev` branch retains development history, papers, experiments, and private
validation records. It stays local. The `release` branch contains the product
source and public documentation and starts from GitHub's initial standalone
snapshot. These histories are intentionally separate.

Use the development checkout for ongoing work and the `linden-release` worktree
for preparing releases. Worktrees share Git objects and configuration but keep
their own checked-out files and indexes.

## Preparing a release

1. Commit the completed development changes on `dev` and record that commit ID.
2. In the release worktree, synchronize reviewed product files from that exact
   development snapshot. Include `src/`, automated tests, generic scripts,
   examples, Rust supervisor source/configuration, npm and TypeScript configuration,
   README, changelog, and reviewed English release/validation documentation.
   The four internal product, programming language, runtime, and type theory
   documents stay on `dev`, regardless of their language. Include newly added
   source files and remove obsolete product files.
3. Keep papers, reference PDFs, submission artifacts, editing archives, experiment
   outputs, manual test transcripts/markers, and raw validation records out of
   `release`. Publish only reviewed validation summaries.
4. Review release-specific README/changelog links and documentation. Preserve
   release-specific edits rather than replacing every document blindly.
5. Run `npm ci`, fetch the locked Cargo dependencies as described in README,
   then run `npm run check`, `npm test`, and `npm run build` in the release
   worktree. Review staged paths and confirm the source matches the intended
   development snapshot.
6. Commit the release and create an annotated version tag on `release` after
   validation succeeds.

Do not merge `dev` into `release`: a merge would make the research commits part
of published history. Apply reviewed product-only changes as independent release
commits. `.gitignore` alone does not exclude files already present in history.

## Publishing

Publishing is a separate action. This checkout uses GitHub SSH over port 443:

```text
ssh://git@ssh.github.com:443/shun-dong/linden.git
```

The local default push refspec is limited to `release`; `dev` has no upstream.
After approval to publish, explicitly push the release branch and its release tag:

```bash
git push origin release
git push origin refs/tags/v1.0.0
```

Use the tag matching the release being published. Do not use `--all`, `--mirror`,
or an unrestricted `--tags` push. Default push settings do not prevent an
explicitly requested push of another branch.

After publishing, you can select `release` as the GitHub default branch in
repository Settings, then create a GitHub Release from the existing version tag
and use the English changelog as its release notes. These are separate remote
actions; preparing the local release does not perform them. Local development commits and internal changelog baseline hashes are
not expected to be available in the public product history.
