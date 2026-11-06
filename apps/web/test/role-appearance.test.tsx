import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { roleColors, type PresenceUser, type RoleSummary } from "@voxly/shared";
import { RoleLabels } from "../src/components/ui/RoleLabels.js";
import { RoleTintedName } from "../src/components/ui/RoleTintedName.js";
import { translate } from "../src/lib/i18n.js";
import { groupOnlineByRole, heldRoles, memberColor } from "../src/lib/roles.js";

const role = (id: string, position: number, extra: Partial<RoleSummary> = {}): RoleSummary => ({
  id,
  serverId: "s",
  name: id,
  color: null,
  position,
  separate: false,
  permissions: [],
  kind: null,
  ...extra
});
const roles = [
  role("admin", 4, { kind: "admin", name: null, color: "#d93f3f", separate: true }),
  role("mods", 3, { separate: true }),
  role("helpers", 2, { color: "#2f9e5b" }),
  role("fans", 1, { color: "#2b7fd4", separate: true }),
  role("everyone", 0, { kind: "everyone", name: null })
];
const user = (userId: string, roleIds: string[]): PresenceUser => ({
  userId,
  nickname: userId,
  role: "member",
  roleIds
});
const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("en", key, values);

describe("what Roles look like (ADR-0038, decisions 11–13)", () => {
  it("colours a name from the highest Role that has a colour, and leaves it alone otherwise", () => {
    assert.equal(memberColor(roles, user("a", ["fans", "mods", "helpers"])), "#2f9e5b");
    assert.equal(memberColor(roles, user("b", ["mods"])), null);
    assert.equal(memberColor(roles, user("c", [])), null);
  });

  it("groups online members under their highest separate Role, once, and leaves the rest under Online", () => {
    const online = [user("a", ["fans", "mods"]), user("b", ["fans"]), user("c", ["helpers"]), user("d", [])];
    const grouped = groupOnlineByRole(roles, online);
    assert.deepEqual(
      grouped.groups.map((group) => [group.role.id, group.members.map((member) => member.userId)]),
      [
        ["mods", ["a"]],
        ["fans", ["b"]]
      ]
    );
    assert.deepEqual(
      grouped.rest.map((member) => member.userId),
      ["c", "d"]
    );
  });

  it("labels a member's Roles highest first with the name beside the colour", () => {
    const html = renderToStaticMarkup(<RoleLabels roles={heldRoles(roles, user("a", ["fans", "admin"]))} t={t} />);
    assert.match(html, /aria-label="Roles"/);
    assert.match(html, /Admin<\/span><\/li><li[^>]*>.*fans/);
    assert.doesNotMatch(html, /@everyone/);
    assert.equal(renderToStaticMarkup(<RoleLabels roles={[]} t={t} />), "");
  });

  it("tints a name only when there is a colour, through the contrast-safe mix", () => {
    assert.match(
      renderToStaticMarkup(<RoleTintedName name="Ada" color="#2f9e5b" />),
      /class="role-tinted" style="--role-color:#2f9e5b"/
    );
    assert.equal(renderToStaticMarkup(<RoleTintedName name="Ada" color={null} />), "<strong>Ada</strong>");
    const styles = readFileSync("src/visual-refresh.css", "utf8");
    assert.match(
      styles,
      /\.role-tinted \{\s*color: color-mix\(in srgb-linear, var\(--role-color\) 50%, var\(--fg\)\);/
    );
  });

  it("keeps every palette colour at 4.5:1 on both themes once mixed toward the text colour", () => {
    const channel = (hex: string, index: number) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    const linear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = (rgb: number[]) => 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
    const lin = (hex: string) => [0, 1, 2].map((index) => linear(channel(hex, index)));
    const mix = (a: string, b: string) => lin(a).map((value, index) => value * 0.5 + lin(b)[index]! * 0.5);
    const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    for (const color of roleColors) {
      // Every surface a name sits on: light text #111317 on surface, bg,
      // surface-warm, rail-surface and surface-2 (a hovered row); dark text
      // #f2f4f7 on bg, surface, rail-bg, surface-warm, rail-surface and surface-2.
      for (const surface of ["#ffffff", "#f3f5f7", "#eef1f4", "#eceff2", "#e6eaee"]) {
        assert.ok(contrast(luminance(mix(color, "#111317")), luminance(lin(surface))) >= 4.5, `${color} on ${surface}`);
      }
      for (const surface of ["#0b0d10", "#12161b", "#101318", "#171c22", "#1a2027", "#202730"]) {
        assert.ok(contrast(luminance(mix(color, "#f2f4f7")), luminance(lin(surface))) >= 4.5, `${color} on ${surface}`);
      }
    }
  });
});
