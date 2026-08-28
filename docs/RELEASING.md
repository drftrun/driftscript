# Releasing

**Two publishes, in one order, and a gate that runs against a tarball rather than against this
workspace.**

**A release is caused by the version changing, and by nothing else.** `.github/workflows/release.yml`
publishes on a push to `main` when the version in the manifests is not yet on the registry, so the
choice is still a person's — it is made by cutting the version rather than by typing `publish` into
a form afterwards. A version already on npm publishes nothing, so a re-run, a revert or a second
push cannot produce a second release.

That idempotence is what replaced the manual gate, and it is a stronger guarantee than the gate
was: there is exactly one way to cause a release, and doing it twice is not one of them. The
`workflow_dispatch` entry stays for a dry run, and on that path `publish` still has to be typed.

---

## The order, and why it is not alphabetical

1. `driftscript`
2. `driftscript-language`

`driftscript-language` pins `driftscript` to the exact version, so publishing it first lists a
package whose dependency does not exist yet. npm will accept that and a consumer's install will not.

**The pin is deliberate and this is the cost of it.** `agreement.test.ts` compiles a corpus through
the server and through the build and asserts the diagnostics are deep-equal. A server running a
different compiler than the build is precisely the disagreement that test exists to prevent, and a
caret range makes it possible for a user without making it visible to one. The price is that a
release is two publishes in a fixed order.

## Before anything

```sh
npm ci
npm run build
npm test                 # the language: 930 tests
npm run test:scripts     # the gates: boundaries, versions, sizes, grammar, editors, publish
npm run typecheck
npm run publish:check    # the clean room. Ten rows, all of them green, or stop
```

`npm run publish:check` is the one that matters and the one that is easiest to skip. It packs both
packages, installs them into an empty project **outside this workspace**, and drives them the way a
stranger would: a Vite config that imports the package, a `.drs` file that has to reach the bundle,
a `tsc --noEmit` with `skipLibCheck: false` and none of our compiler flags, and an LSP `initialize`
against the installed binary.

**Checking the workspace copy is what hid the defect that made this repository necessary.** A check
that reproduces the original mistake is worse than no check. It needs the network, which is why it
is not part of `npm test`.

## Cutting the version

One number moves in five places, and the count is asserted rather than remembered — see
`scripts/version.test.mjs`.

```sh
npm version <new> --workspaces --no-git-tag-version --include-workspace-root
# then, by hand: the `driftscript` range inside packages/driftscript-language/package.json
npm install                    # a full install, not --package-lock-only. See below.
npm run test:scripts           # scripts/workspace.test.mjs is the one that catches this
```

**`npm version --workspaces` also moves the editor client, which is not on this line.** It walks
every workspace member, so `editors/vscode/package.json` comes back bumped to the language's number
— and it rewrites that file's escaped characters while it is there, so the diff is larger than the
one line it looks like. Check the file out again and set its own number by hand. Nothing ships wrong
if this is missed: `scripts/version.test.mjs` asserts the client is *not* on the shared line, and
that is the test that catches it.

**`npm version --workspaces` installs, and it installs in the window where the range is wrong.** It
moves `version` in every manifest before you have fixed the range that names it, so for that moment
`driftscript-language` depends on the *previous* version while the workspace copy is the new one —
npm cannot link the sibling, and does the reasonable thing instead: it fetches the published
previous release into `packages/driftscript-language/node_modules/`. Fixing the range afterwards
does not remove it, and `--package-lock-only` writes a lockfile rather than a tree, so the stale copy
stays.

Everything then passes locally against **the previous release of the compiler**, including the
agreement test whose whole job is that the server and the build are the same code. It has happened
twice; the second time `scripts/workspace.test.mjs` named it in seconds.

The lockfile is the one that is invisible locally. Every package here is a workspace link, so a
range left behind resolves to whatever is on disk and stays green through every command — right up
until npm goes to the registry on a machine with no workspace and gets a 404 for a version that has
never existed. The error names the registry rather than the bump, so it reads as infrastructure.
That is not a hypothetical; it is how the first release on this version line failed.

Then write the changelog entry. `scripts/version.test.mjs` fails if `CHANGELOG.md` does not open on
the version the manifests say, because a number with no entry is a release nobody described — and a
reader who arrives from npm has nowhere else to look.

**The bump, the range, the lockfile and the changelog go in one commit**, because pushing the bump
is what starts the release. A bump pushed without its entry does not publish a described release —
it fails that gate and publishes nothing, which is the right way round, but it costs a run and
leaves a red mark against a commit that was only half of a release.

## Publishing

**Push the bump and the changelog to `main`, and that is the release.** The workflow runs `npm ci`,
the build, the typecheck, both suites and `publish:check` on the exact commit, then publishes the
two packages in order with provenance. A run that fails halfway can be re-run: each publish step is
skipped when that package's version is already on the registry, so it finishes the half that is
left.

By hand from a laptop, without provenance, if the workflow is unavailable:

```sh
npm login          # 2FA on the account
npm publish -w driftscript --access public
npm publish -w driftscript-language --access public
```

**`--provenance` is deliberately not in those commands.** It needs a CI runner with an OIDC identity
and a public repository, and npm does not degrade gracefully without one: it fails with
`Provenance generation in npm is not supported in this environment` instead of publishing without an
attestation. Passing it locally does not get you an unsigned publish, it gets you no publish.

The automated path needs an `NPM_TOKEN` secret on the repository, and the repository has to be
public for the attestation to verify. Both are true today.

**That token expires, and the failure will not look like an expiry.** The one configured on
2026-08-27 is a granular token with read-write on `driftscript` and `driftscript-language` and a
90-day life, so it lapses around **2026-11-25**. After that a release runs every gate green and
fails on the last step with a 401 that reads as a registry problem. Replace it at
[npmjs.com/settings/emulator000/tokens](https://www.npmjs.com/settings/emulator000/tokens) and
`gh secret set NPM_TOKEN -R drftrun/driftscript`.

To publish without pushing a bump — or to prove the gates without publishing — run the **Release**
workflow by hand. `confirm=publish` publishes; anything else is a dry run.

Either way `prepack` runs the build, so a tarball is never made from a stale `dist/`.

## Afterwards

The tag is not automated, deliberately: it should mark a version that actually reached the registry,
and only the run knows whether it did.

```sh
git tag v<version> && git push --tags
```

And update anything that consumes the language from the registry rather than from a workspace.

## The editor client

A different registry, a different identity, and its own version number. It is not part of the npm
release and does not have to happen at the same time.

### When it has to be re-cut, and when it does not

The client **bundles its own server**, frozen at the moment the `.vsix` was packed, because a
marketplace install has no `packages/driftscript-language` to walk up to. So the question is never
"did the language release" — it is **what would a bundled server of that vintage say about code
somebody can write today**. Two cases, and they are not the same urgency:

- **It cannot parse the syntax.** Re-cut now. This is what 1.6.0 did: module constants, lists,
  `break` and `continue` made a 1.4.0-era server report `DS0100`/`DS0135`/`DS0102` and never
  recover, so a whole valid document went red. A squiggle that is sometimes wrong is worse than
  none, and this is the packaging producing exactly that.
- **It cannot type something a host describes.** Re-cut when the host ships it, not when the
  language does. 1.7.0 let a capability name `List<T>`, and a 1.6.0 server answers
  `DS0237 \`List<f32>\` is not a type this host registered` — but only against a registry that has
  one, and until a host registers such a capability there is nothing to be wrong about. Every 1.7.0
  *script* form compiles clean on the 0.3.0 server, which was checked rather than assumed.

**The first case is now a gate rather than a habit.** `scripts/editors.test.mjs` packs the `.vsix`,
spawns the server inside it, opens a document holding every form the language has, and fails if a
lexical or syntactic diagnostic comes back — naming the code the packed server produced. So a client
that has fallen behind the compiler is caught by `npm run test:scripts` instead of by remembering to
check. A `DS02xx` is not a failure there: that server starts with no host, and a name only a registry
could supply is expected to be unknown.

The second case has no gate and cannot have one here, since it depends on a host's registry rather
than on this repository. The cheap test for it is the one used both times: install the version the
published `.vsix` bundles into an empty project, and run the code in question through it.

```sh
npm run vsix                                    # builds and packages, into editors/vscode/
code --install-extension editors/vscode/*.vsix  # what a marketplace install would be
```

Publishing it needs three things that are not code, and two of the three have a trap in them.

**`portal.azure.com` is not involved.** That is Azure's cloud console, it has no Marketplace
section, and there is nothing to find there. The two sites that matter are `dev.azure.com` for the
token and `marketplace.visualstudio.com/manage` for the publisher. Same Microsoft account, different
products.

### The short way: upload the `.vsix` by hand

**No token and no Azure DevOps organisation are needed to publish.** `vsce` automates an upload the
Marketplace will also accept through its own web form, and that form is on the same page where the
publisher is created:

1. [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage), **Create
   publisher**, note the id.
2. Set that id as `publisher` in `editors/vscode/package.json` — it is `DriftTech` today. **Before
   packaging**, because the id is baked into the `.vsix` and the Marketplace rejects one whose
   publisher does not match the account uploading it.
3. `npm run vsix` from the repository root.
4. On the same manage page, **New extension → Visual Studio Code**, and upload
   `editors/vscode/driftscript-vscode-<version>.vsix`.

**`displayName` is globally unique across the Marketplace and `DriftScript` is not ours.**
`BRZDRIFT.driftscript-language` has held it since June 2026, for an unrelated project — "the
official scripting language of Drift Wars". So the listing is **DriftScript (.drs)**, and an upload
under the bare name is refused with *this extension display name is taken*.

**The check is a similarity check, not an equality check, and it refuses twice.** `DriftScript
Language Support` was free as an exact name and still rejected, for being too close to `PureScript
Language Support` — a shape that also holds Tasmota, Logic, Minecraft, DMELL and several more. So a
replacement has to be structurally different rather than merely unused, and adding a qualifier to
the crowded pattern does not count as different.

Nothing else collides: the extension id `DriftTech.driftscript-vscode` is unique per publisher, both
npm names are ours, and the in-editor language id and alias are local to a VSCode install.

This is worth knowing about because the token route has a dependency the upload route does not:
creating an Azure DevOps organisation. **That step can ask to attach an Azure plan**, which is the
Azure-portal flow rather than the DevOps one, and it is a wall with nothing behind it for this
purpose.

The token route below is better for repeat releases, since `vsce publish` is one command. Set it up
when the first listing already exists and there is no hurry.

### 1. A token, from Azure DevOps

Sign in at [dev.azure.com](https://dev.azure.com) with the account the publisher will belong to.
Signing in creates an organisation named after the email handle.

**The onboarding then asks for a first project, and a project is not needed.** Projects hold repos,
boards and pipelines; a token belongs to the *organisation*. Skip that screen —
[aex.dev.azure.com/me](https://aex.dev.azure.com/me) lists the organisations that exist, and the
token page is reachable directly at `https://dev.azure.com/<org>/_usersSettings/tokens`.

**If that screen's Continue button does nothing at all, check the profile page first.**
[aex.dev.azure.com/me](https://aex.dev.azure.com/me) shows the organisations that exist and the
state of the account, and *an unconfirmed contact email blocks organisation creation* — the form
carries on looking clickable and reports nothing. That page also carries a **Create new
organization** button, which is the direct route and skips the project form entirely.

Two things worth knowing about that confirmation. It goes to the **contact** email on the profile,
which is not necessarily the address the account signs in with, and Microsoft's confirmations land
in spam often enough to be worth checking. **Edit profile** resends it, and can point it somewhere
easier to read.

A dead Continue button *can* also be strict tracking protection or an ad blocker, since Azure DevOps
fails silently under both. Check the profile page first: it is one click and it either names the
problem or rules it out.

The publisher in step 2 has no dependency on any of this, so it can be created first, and doing so
separates an Azure DevOps problem from an account problem.

Once the tokens page loads:

- the **user settings** icon, top right beside the avatar, then **Personal access tokens** — or go
  straight to `https://dev.azure.com/<org>/_usersSettings/tokens`
- **+ New Token**
- **Organization: All accessible organizations.** *A token scoped to one organisation is accepted
  at `vsce login` and refused at `vsce publish`*, so the failure arrives after the step that looked
  like it validated the token, and reads as a broken token instead of a wrongly scoped one.
- **Scopes: Show all scopes.** *Marketplace is not in the default list and the link that reveals it
  is easy to miss.* Then **Marketplace → Manage**.
- **Create**, and copy the token now. It is shown once.

### 2. A publisher, from the Marketplace

[marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage), same account,
**Create publisher**. The **ID** is the part that matters: lowercase, no spaces, **permanent**, and
it becomes half of the extension's unique identifier, `<publisher>.driftscript-vscode`. That id goes
in `editors/vscode/package.json` as `publisher`, replacing `unpublished`.

### 3. The documents, in the same commit

Four of them claim the extension is unlisted: the root README's package table, the extension's
README, and two paragraphs of `CHANGELOG.md`. `scripts/editors.test.mjs` fails once a real publisher
is set and names the ones still disagreeing. The extension README's "Loading it" section also needs
demoting to the contributor path, since an installed extension needs no symlink.

### Then

```sh
cd editors/vscode
npx vsce login <publisher-id>   # paste the token
npx vsce publish
```

Or in one step, without storing the token: `npx vsce publish -p <token>`. To publish a `.vsix` that
has already been built and checked, `npx vsce publish -i <path to .vsix>`.

**There is a route with no token in it**, worth knowing about if Azure DevOps will not cooperate:
`npx vsce publish --azure-credential` authenticates with Microsoft Entra ID instead. It needs the
Azure CLI installed and `az login` done first, and it still needs the publisher from step 2.

`private: true` stays in the manifest. It is npm's field, `vsce` ignores it, and it is what stops
the extension being published to the wrong registry.

## What a release is not

**At most one release per working session**, carrying everything that session finished. A minor
where public surface was added or its behaviour changed; a patch where nothing a consumer can name
is different.

A version number is quoted in bug reports and compared across machines. Sixteen releases in a week
makes every one of those conversations harder, and that is not a hypothetical either.
