#!/bin/sh
# Puts the Selan layout into Herdr and turns it on: the layout (its look included) and its mods.
set -eu
cd "$(dirname "$0")"
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
while read -r f; do
  [ -n "$f" ] || continue
  rm -rf "$HOME_DIR/$f"
  mkdir -p "$(dirname "$HOME_DIR/$f")"
  cp -R "./$f" "$HOME_DIR/$f"
done < files.txt
for m in selan-spaces selan-chrome selan-status selan-reactor; do
  herdr-app check "$HOME_DIR/mods/$m"
done
herdr-app do layout.switch '{"name":"selan"}'
echo "Installed into $HOME_DIR"
