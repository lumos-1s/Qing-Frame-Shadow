# SignPath Foundation setup

This directory contains the artifact configurations used by
`.github/workflows/release-signpath.yml`. They are versioned here for review,
but SignPath does not read them from the repository: after the SignPath project
is approved, paste their contents into the project's **Artifact Configurations**
UI and use the slugs below.

## Artifact configurations

### `qingframe-app`

File: [`qingframe-app.xml`](./qingframe-app.xml)

Signs `Qingframe.exe` before electron-builder packages it into the installer and
portable executable.

Parameters:

- `version` — `0.1.21`
- `app-version` — `0.1.21.0`

`app-version` is separate because electron-builder writes the application PE
`ProductVersion` as a four-part version, while `FileVersion` is three-part.

### `qingframe-installers`

File: [`qingframe-installers.xml`](./qingframe-installers.xml)

Signs the NSIS installer and portable executable after electron-builder builds
them from the signed application directory.

Parameter:

- `version` — `0.1.21`

The artifact configuration expects the ZIP created by
`actions/upload-artifact` to contain exactly these files at its root:

- `Qingframe-Setup-<version>-x64.exe`
- `Qingframe-Portable-<version>-x64.exe`

Because the installers are built with `electron-builder --prepackaged`, the
normal publish manager does not create `resources/app-update.yml`. The workflow
runs `tools/prepare-app-update.js` after signing the application and before
building the installers, using the GitHub publish config and the actual signer
subject returned by SignPath (with `package.json` as the fallback).

## Application answers

Use these values in the SignPath Foundation application:

- **Project name:** `QingFramShadow（清框影）`.
- **Repository:** <https://github.com/lumos-1s/Qing-Frame-Shadow>
- **Homepage:** <https://github.com/lumos-1s/Qing-Frame-Shadow>
- **Download:** <https://github.com/lumos-1s/Qing-Frame-Shadow#download>
- **Privacy policy:** <https://github.com/lumos-1s/Qing-Frame-Shadow/blob/main/PRIVACY.md>
- **License:** MIT.
- **Category:** Graphics.
- **Tagline:** QingFramShadow is an open-source, local-first Windows app for
  framing and finishing photos.
- **Description:** QingFramShadow is an open-source, local-first Windows app for
  framing and finishing photos. It offers reusable templates, live border,
  shadow, texture, logo and EXIF controls, collage, grid slicing and batch
  export. Photos stay on the user's computer: no account, upload, analytics or
  telemetry.
- **Reputation:** Public MIT-licensed GitHub project with a continuous release
  history, public source, build workflow, release notes, and documented
  code-signing and privacy policies. Actively maintained; early-stage project.
- **Maintainer type:** Individual maintainer(s).
- **Build system:** GitHub Actions (GitHub.com trusted build system;
  GitHub-hosted `windows-latest` runners only).
- **Workflow:** `.github/workflows/release-signpath.yml`.
- **Signed artifacts:** NSIS installer, portable executable, and the packaged
  application executable.
- **Approval:** manual approval for every signing request; two requests per
  release (application executable, then installers).

## Eligibility note before applying

SignPath's OSS terms require compatible open-source licensing for all distributed
components. `THIRD-PARTY-ASSETS.md` currently marks the textures under
`shared/textures/` as third-party material whose terms still need verification.
Resolve or replace those assets if SignPath raises the issue; the brand-logo
directory is already excluded from release builds.

## SignPath project settings

After SignPath approves the application:

- Project slug: `qingframe` (or another slug; set the repository variable to
  match).
- Signing policy slug: `release-signing`.
- Trusted build system: add the predefined **GitHub.com** trusted build system
  to the organization and link it to this project.
- Install the [SignPath GitHub App](https://github.com/apps/signpath) and grant
  it access to this repository.
- Origin verification: enable it and restrict signing to the `main` branch.
- Require manual approval for each signing request.
- Add `@lumos-1s` as approver, and create a CI user/token with submitter
  permission for the project and signing policy.

The workflow uses only GitHub-hosted `windows-latest` runners, as required for
SignPath's OSS signing policy.

## GitHub repository configuration

Create this Actions secret:

- `SIGNPATH_API_TOKEN` — API token of the SignPath CI user with submitter
  permission.

Create these Actions variables:

- `SIGNPATH_ORGANIZATION_ID` — SignPath organization ID.
- `SIGNPATH_PROJECT_SLUG` — `qingframe`.
- `SIGNPATH_SIGNING_POLICY_SLUG` — `release-signing`.
- `SIGNPATH_APP_CONFIG_SLUG` — `qingframe-app`.
- `SIGNPATH_INSTALLER_CONFIG_SLUG` — `qingframe-installers`.

Do not put the API token in the repository or in a workflow file.

## Metadata restrictions

The XML configurations restrict the signed files to the metadata emitted by
electron-builder:

- Product name: `清框影`
- Company name: `Qingframe`
- Application executable: `ProductVersion` `0.1.21.0`, `FileVersion` `0.1.21`
- Installer/portable: `ProductVersion` and `FileVersion` `0.1.21`

If `productName`, `executableName`, or version formatting changes, update the
XML and the SignPath artifact configuration before the next release.
