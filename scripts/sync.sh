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

mods=(jj-changes jj-log jj-spaces my-agents my-tabs calendar)
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
    rsync "${file_options[@]}" "$source_dir/$file" "$destination_dir/$file"
    printf '%s file: %s\n' "$([[ $dry_run == true ]] && echo 'Checked' || echo 'Synced')" "$file"
  fi
done

if [[ "$direction" == to && "$dry_run" == false ]]; then
  npm ci --prefix "$destination_dir/mods/calendar" --omit=dev
fi
