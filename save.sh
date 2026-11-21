#!/bin/sh
# Copies this setup from Herdr into the repo: only the files in files.txt, never Herdr's state.
set -eu
cd "$(dirname "$0")"
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
while read -r f; do
  [ -n "$f" ] || continue
  rm -rf "./$f"
  mkdir -p "$(dirname "./$f")"
  cp -R "$HOME_DIR/$f" "./$f"
done < files.txt
find mods -name '*.d.ts' -o -name jsconfig.json -o -name '*.error' | xargs rm -f
echo "Saved from $HOME_DIR"
