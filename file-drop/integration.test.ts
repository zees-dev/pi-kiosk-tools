import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = "/home/pi/pi-kiosk-tools";
const nixConfigPath = "/home/pi/nixos/pi5/pi5b11-256/configuration.nix";

describe("File Drop integration", () => {
  it("is listed in the kiosk dashboard apps section", () => {
    const dashboard = readFileSync(join(repoRoot, "dashboard", "kiosk-dashboard.ts"), "utf8");

    expect(dashboard).toContain('{ id: "filedrop", name: "File Drop"');
    expect(dashboard).toContain('url: `http://${ip}:3463`');
    expect(dashboard).toContain('section: "apps"');
  });

  it("has a declarative NixOS systemd service", () => {
    const config = readFileSync(nixConfigPath, "utf8");

    expect(config).toContain("systemd.services.file-drop = {");
    expect(config).toContain('WorkingDirectory = "/home/pi/pi-kiosk-tools/file-drop";');
    expect(config).toContain('echo "Starting File Drop on http://localhost:3463"');
    expect(config).toContain('exec bun run file-drop.ts');
    expect(config).toContain('wantedBy = [ "multi-user.target" ];');
  });
});
