# Building SpaghettiKart on Raspberry Pi 5 (NixOS)

SpaghettiKart is a Mario Kart 64 PC port by [HarbourMasters](https://github.com/HarbourMasters/SpaghettiKart).
No prebuilt arm64 binary exists — must build from source.

## Prerequisites

- Raspberry Pi 5 running NixOS
- ~2GB free disk space
- US Mario Kart 64 ROM (`.z64`, SHA-1: `579c48e211ae952530ffc8738709f078d5dd215e`)

## Build Steps

### 1. Clone the repo

```bash
git clone --recursive https://github.com/HarbourMasters/SpaghettiKart.git
cd SpaghettiKart
```

### 2. Apply NixOS patches

Two source fixes are needed for NixOS (GCC 14 + hardening flags):

**Remove LTO** — NixOS injects `-Werror=format-security` during LTO linking, causing undefined ImGui references:

```bash
# CMakeLists.txt line ~143: remove "-flto=auto \"
sed -i '/-flto=auto/d' CMakeLists.txt
```

**Fix format-security** — `ImGui::Text(title)` triggers `-Werror=format-security`:

```bash
sed -i 's/ImGui::Text(title);/ImGui::Text("%s", title);/' src/port/ui/Properties.cpp
```

### 3. Enter nix-shell and build

```bash
nix-shell shell.nix --run 'cmake -H. -Bbuild -GNinja -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release -j4'
```

Build takes ~40 minutes on Pi 5 with 4 cores.

### 4. Extract game assets

```bash
cd build

# Extract ROM assets into mk64.o2r (requires mods.toml for version tagging)
cat > /tmp/mods.toml << 'EOF'
[mod]
name="mk64-assets"
version="1.0.0-alpha1"
EOF

./TorchExternal/src/TorchExternal-build/torch o2r "../Mario Kart 64 (USA).z64" -s .. -d . -a /tmp/mods.toml

# Pack engine assets into spaghetti.o2r
./TorchExternal/src/TorchExternal-build/torch pack ../assets spaghetti.o2r o2r
cp ../spaghetti.o2r .
```

### 5. Create runtime directories

```bash
mkdir -p mods logs saves
chmod 777 mods logs saves
```

### 6. Run

SpaghettiKart needs a Wayland compositor with DRM access (like the kiosk's Cage):

```bash
sudo -u kiosk env \
  XDG_RUNTIME_DIR=/run/user/1001 \
  LIBSEAT_BACKEND=seatd \
  HOME=/var/cache/kiosk-home \
  SDL_VIDEODRIVER=wayland \
  cage -s -d -- ./Spaghettify
```

**Note:** The kiosk service must be stopped first (only one Cage/DRM session at a time).

## Build Output

```
build/
├── Spaghettify        # 17MB aarch64 executable
├── mk64.o2r           # 26MB game assets (from ROM)
├── spaghetti.o2r      # 2.6MB engine assets
├── mods/              # mod directory (writable)
├── logs/              # game logs
├── saves/             # save data
├── config.yml         # asset config (auto-copied)
└── yamls/             # asset metadata (auto-copied)
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `undefined reference to ImGui::*` | Remove `-flto=auto` from CMakeLists.txt |
| `-Werror=format-security` | Fix `ImGui::Text(title)` → `ImGui::Text("%s", title)` |
| `cannot create directories: Permission denied [./mods]` | `mkdir -p mods logs saves && chmod 777 mods logs saves` |
| `seatd: Could not get primary session` | Use `LIBSEAT_BACKEND=seatd` (not `logind`) |
| `Broken pipe` from seatd | `systemctl restart seatd` before launching |
| `Dependency Issues: mk64-assets` | Re-extract mk64.o2r with `-a mods.toml` containing `name="mk64-assets"` |
| `No O2R Files` | Ensure `mk64.o2r` is in the same directory as `Spaghettify` |
