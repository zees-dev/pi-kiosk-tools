{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  nativeBuildInputs = with pkgs; [ cmake ninja python3 pkg-config ];
  buildInputs = with pkgs; [
    SDL2 SDL2_net libpng libzip nlohmann_json tinyxml-2 spdlog boost
    libGL libogg libvorbis
    xorg.libX11 xorg.libXrandr xorg.libXinerama xorg.libXcursor xorg.libXi
    xorg.libXext xorg.libXxf86vm wayland wayland-protocols libxkbcommon
    libdecor
  ];
}
