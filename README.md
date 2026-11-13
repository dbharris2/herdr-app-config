# Herdr App configuration

Personal Herdr App layout, mods, keybindings, and settings. The `jj-main`
layout uses `jj-changes`, `jj-log`, `jj-spaces`, `my-agents`, `my-tabs`, `calendar`, and `pr-monitor` alongside
Herdr's shipped mods. The Jujutsu panels require `jj` on Herdr's PATH.

## Sync

```sh
./sync-from             # Herdr App → this repo
./sync-to               # this repo → Herdr App
./sync-from --dry-run   # check sources without writing
./sync-to --dry-run
```

The default Herdr folder is `~/.config/herdr-app`. Set `HERDR_APP_HOME` to
select another one. The scripts can be run from any working directory.

Each sync copies `layouts/jj-main.json`, `keys.json`, and `settings.json`, and
mirrors the mod directories. Files removed from a source mod are deleted
from the matching destination mod; other layouts, mods, and files are left
alone. The scripts exclude Herdr's generated `gpui-kit.d.ts`, `.DS_Store`, and
mod error files, and preserve those excluded files at the destination. A sync
overwrites differences in the chosen direction. Review `jj diff` before
syncing from Herdr if the repo contains edits you want to keep.

Herdr reloads changes live. After syncing to Herdr, check the mods with
`herdr-app check ~/.config/herdr-app/mods/<name>` and inspect `herdr-app status`
for errors. Switch to the `jj-main` layout in Herdr if it isn't selected.
For a custom `HERDR_APP_HOME`, use that folder in the check command instead.

Generated guides, shipped mods and layouts, window state, session state, and
mod data aren't included. The layout relies on the shipped mods in the Herdr
App installation. Review settings and paths before publishing this repo.

The Calendar panel reads a Google Calendar secret iCal feed. Click Link calendar
and paste the address into the secure prompt; macOS Keychain stores it outside
this repository. The panel shows the current workweek and refreshes every five
minutes. Node.js and npm are required; sync-to installs the calendar parser.

The Pull requests panel uses the authenticated GitHub CLI (`gh`) and refreshes every five minutes.
