# pi-kiosk-tools

Utility services for a Raspberry Pi kiosk setup. Each tool is a single self-contained TypeScript file running on [Bun](https://bun.sh).

## Tools

| Tool | Port | Description |
|------|------|-------------|
| `bluetooth-manager.ts` | 3456 | Web UI for Bluetooth device pairing, with D-Bus BlueZ agent and SNIFF latency optimizer |
| `wifi-manager.ts` | 3457 | Web UI for WiFi network management via NetworkManager |
| `remote-pad.ts` | 3458 | Forward local controllers to PS4 via WebSocket (GoldHEN RemotePad) |

## Setup

```bash
bun install
```

## Run

```bash
# Bluetooth Manager (needs D-Bus access)
bun run bluetooth-manager.ts

# WiFi Manager (needs root for nmcli)
sudo bun run wifi-manager.ts

# RemotePad Bridge (needs root for /dev/input)
sudo bun run remote-pad.ts
```

## Requirements

- [Bun](https://bun.sh) runtime
- Linux with BlueZ (bluetooth-manager)
- NetworkManager (wifi-manager)
- GoldHEN RemotePad plugin on PS4 (remote-pad)

## License

MIT
