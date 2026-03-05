# pi-kiosk-tools

Utility services for a Raspberry Pi 5 retro gaming kiosk running NixOS. Each service is a single self-contained TypeScript file running on [Bun](https://bun.sh) with zero external dependencies (except `dbus-next` for Bluetooth).

## Services

| Service | Port | Directory | Description |
|---------|------|-----------|-------------|
| **Kiosk Dashboard** | 80 | `dashboard/` | Main kiosk control panel — service toggles, display & audio settings, remote touchpad, process manager |
| **Bluetooth Manager** | 3456 | `bluetooth/` | Bluetooth device pairing with D-Bus BlueZ agent, one-click pair, HID auto-rebind, low-latency SNIFF optimization |
| **WiFi Manager** | 3457 | `wifi/` | WiFi network scanning, connecting, and management via NetworkManager |
| **RemotePad** | 3458 | `remote-pad/` | Forward local controllers to PS4 via WebSocket (GoldHEN RemotePad bridge) |
| **Dolphin Manager** | 3460 | `dolphin/` | Dolphin Emulator launcher — ROM browser, save management, dynamic controller mapping, performance profiles |
| **Virtual Pad** | 3461 (HTTPS) | `virtual-pad/` | Web-based gamepad — phone touchscreen → WebSocket → uinput evdev device. Supports up to 4 players |
| **SpaghettiKart** | 3462 | `spaghetti-kart/` | Mario Kart 64 PC port launcher — start/stop game, configure settings, view controllers |

## Additional

| Name | Directory | Description |
|------|-----------|-------------|
| ~~SpaghettiKart docs~~ | `spaghetti-kart/` | Also contains BUILD-PI5.md and shell.nix for building from source |

## Setup

```bash
bun install
```

## Requirements

- [Bun](https://bun.sh) runtime
- NixOS on Raspberry Pi 5 (Cage Wayland compositor for kiosk mode)
- BlueZ (bluetooth), NetworkManager (wifi), PipeWire (audio)

## License

MIT
