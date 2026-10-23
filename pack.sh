#!/bin/sh
# Builds dist/sys-stats-ai@startswest.github.io.shell-extension.zip, the file to
# upload at https://extensions.gnome.org/upload/
set -e
cd "$(dirname "$0")"
mkdir -p dist  # gnome-extensions pack crashes if the output dir is missing
gnome-extensions pack --force --out-dir=dist \
    --extra-source=widget.js \
    --extra-source=stats.js \
    --extra-source=claude.js \
    --extra-source=icons \
    --extra-source=LICENSE
