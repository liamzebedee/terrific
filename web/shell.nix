# Dev shell for proto tooling: `nix-shell` puts buf on PATH, then
# `bun run gen` (or the dev server's proto watcher) regenerates src/gen.
#
# nixpkgs is pinned via fetchTarball so this works without a configured
# channel (this machine has none).
{ pkgs ? import (fetchTarball "https://github.com/NixOS/nixpkgs/archive/nixos-25.05.tar.gz") { } }:

pkgs.mkShell {
  packages = [ pkgs.buf ];
}
