# Privacy policy

清框影 / QINGFRAME is a local-first Windows desktop application.

## Photos and project data

- Photos, edited images, presets, signatures, avatars, and project files are
  processed and stored on your computer.
- The application does not upload your photos or project data to this project's
  servers.
- There is no account, login, analytics, or telemetry.

## Network connections

The application checks GitHub Releases for updates:

- On startup (after a short delay), and when you choose "check for updates".
- It requests release metadata from
  `https://github.com/lumos-1s/Qing-Fram-Shadow/releases`.
- Update downloads are requested only after you choose to download an update.
- These requests go directly to GitHub by default; the application does not
  route them through third-party update mirrors on its own. They are subject to
  GitHub's privacy policy.
- Advanced: you may enter a download mirror under "About → 更新下载源". If set,
  only the **installer download** goes to that host; the release metadata and
  the SHA-512 used to verify the file still come from GitHub, so a mirror
  cannot substitute a different binary without failing the check. Leave it
  empty to connect to GitHub directly.

External links are opened only when you choose them.

## Local storage

Settings, templates, cached update files, and other application data are stored
in the Electron user-data directory on your computer. Uninstalling the
application may leave user-created files and settings behind; remove them
manually if you want a complete cleanup.

## Contact

Privacy questions can be raised at
<https://github.com/lumos-1s/Qing-Fram-Shadow/issues>.

Except for the update checks described above, this program will not transfer
any information to other networked systems unless specifically requested by the
user or the person installing or operating it.
