#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
app_dir="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
direction="${1:?missing sync direction}"
shift

dry_run=false
if [[ ${1:-} == --dry-run ]]; then
  dry_run=true
  shift
fi
if (( $# )); then
  echo "Usage: $0 {from|to} [--dry-run]" >&2
  exit 2
fi

case "$direction" in
  from) source_dir="$app_dir"; destination_dir="$repo_dir" ;;
  to) source_dir="$repo_dir"; destination_dir="$app_dir" ;;
  *) echo "Unknown sync direction: $direction" >&2; exit 2 ;;
esac

mods=(sidebar-tabs agent-starter jj-changes jj-log jj-spaces my-agents my-tabs calendar pr-monitor)
files=(layouts/jj-main.json keys.json settings.json)

# Check every source before changing anything at the destination.
for mod in "${mods[@]}"; do
  if [[ ! -d "$source_dir/mods/$mod" || ! -f "$source_dir/mods/$mod/main.js" || ! -f "$source_dir/mods/$mod/mod.json" ]]; then
    echo "Missing mod or its main.js/mod.json: $source_dir/mods/$mod" >&2
    exit 1
  fi
done
for file in "${files[@]}"; do
  if [[ ! -f "$source_dir/$file" ]]; then
    echo "Missing file: $source_dir/$file" >&2
    exit 1
  fi
done

# A person's live zoom is local to their screen. Prepare the merged settings
# before syncing anything, so invalid JSON cannot leave a partial sync.
settings_source="$source_dir/settings.json"
if [[ "$direction" == to && -f "$destination_dir/settings.json" ]]; then
  settings_tmp="$(mktemp -d)"
  trap 'rm -rf "$settings_tmp"' EXIT
  node - "$settings_source" "$destination_dir/settings.json" "$settings_tmp/settings.json" <<'NODE'
const fs = require("fs");
const [source, destination, output] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(source, "utf8"));
const live = JSON.parse(fs.readFileSync(destination, "utf8"));
if (Object.hasOwn(live, "zoom")) settings.zoom = live.zoom;
else delete settings.zoom;
fs.writeFileSync(output, JSON.stringify(settings, null, 2) + "\n");
NODE
  settings_source="$settings_tmp/settings.json"
fi

mod_options=(-rltc --delete --exclude=gpui-kit.d.ts --exclude=node_modules --exclude=.DS_Store --exclude='*.error')
file_options=(-ltc)
if "$dry_run"; then
  mod_options+=(--dry-run --itemize-changes)
  file_options+=(--dry-run --itemize-changes)
else
  mkdir -p "$destination_dir/mods" "$destination_dir/layouts"
fi
for mod in "${mods[@]}"; do
  # Excluded files are protected from --delete at the destination too.
  if "$dry_run" && [[ ! -d "$destination_dir/mods" ]]; then
    printf 'Would create mod: %s\n' "$mod"
  else
    rsync "${mod_options[@]}" "$source_dir/mods/$mod" "$destination_dir/mods/"
    printf '%s mod: %s\n' "$([[ $dry_run == true ]] && echo 'Checked' || echo 'Synced')" "$mod"
  fi
done
for file in "${files[@]}"; do
  if "$dry_run" && [[ ! -d "$(dirname "$destination_dir/$file")" ]]; then
    printf 'Would create file: %s\n' "$file"
  else
    file_source="$source_dir/$file"
    if [[ "$file" == settings.json ]]; then file_source="$settings_source"; fi
    rsync "${file_options[@]}" "$file_source" "$destination_dir/$file"
    printf '%s file: %s\n' "$([[ $dry_run == true ]] && echo 'Checked' || echo 'Synced')" "$file"
  fi
done

if [[ "$direction" == to && "$dry_run" == false ]]; then
  npm ci --prefix "$destination_dir/mods/calendar" --omit=dev
fi
