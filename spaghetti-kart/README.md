# SpaghettiKart (Mario Kart 64 PC Port)

[SpaghettiKart](https://github.com/HarbourMasters/SpaghettiKart) is a native PC port of Mario Kart 64 by HarbourMasters (the Ship of Harkinian team). It runs natively on the Pi 5 via OpenGL ES — no emulation needed.

## Quick Start

```bash
# Clone and patch
git clone --recursive https://github.com/HarbourMasters/SpaghettiKart.git /home/pi/SpaghettiKart
sed -i '/-flto=auto/d' /home/pi/SpaghettiKart/CMakeLists.txt
sed -i 's/ImGui::Text(title);/ImGui::Text("%s", title);/' /home/pi/SpaghettiKart/src/port/ui/Properties.cpp

# Build (~40 min on Pi 5)
cd /home/pi/SpaghettiKart
cp /home/pi/pi-kiosk-tools/spaghetti-kart/shell.nix .
nix-shell shell.nix --run 'cmake -H. -Bbuild -GNinja -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release -j4'

# Extract assets (requires US MK64 ROM)
cd build
cat > /tmp/mods.toml << 'EOF'
[mod]
name="mk64-assets"
version="1.0.0-alpha1"
EOF
./TorchExternal/src/TorchExternal-build/torch o2r "../Mario Kart 64 (USA).z64" -s .. -d . -a /tmp/mods.toml
./TorchExternal/src/TorchExternal-build/torch pack ../assets spaghetti.o2r o2r
cp ../spaghetti.o2r .
mkdir -p mods logs saves && chmod 777 mods logs saves
```

## Launch (Kiosk)

```bash
# Stop kiosk first (only one DRM session at a time)
sudo -u kiosk env \
  XDG_RUNTIME_DIR=/run/user/1001 \
  LIBSEAT_BACKEND=seatd \
  HOME=/var/cache/kiosk-home \
  SDL_VIDEODRIVER=wayland \
  cage -s -d -- /home/pi/SpaghettiKart/build/Spaghettify
```

## Files

| File | Purpose |
|------|---------|
| `shell.nix` | NixOS build dependencies |
| `BUILD-PI5.md` | Detailed build guide with troubleshooting |

## NixOS Patches Required

1. **Remove `-flto=auto`** — NixOS injects `-Werror=format-security` during LTO, breaking ImGui linking
2. **Fix `ImGui::Text(title)`** → `ImGui::Text("%s", title)` — format-security compliance

## Requirements

- Raspberry Pi 5, NixOS, ~2GB disk
- US Mario Kart 64 ROM (`.z64`, SHA-1: `579c48e211ae952530ffc8738709f078d5dd215e`)
