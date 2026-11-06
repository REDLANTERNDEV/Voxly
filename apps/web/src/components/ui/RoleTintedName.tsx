import type { RoleColor } from "@voxly/shared";
import type { CSSProperties } from "react";

/**
 * A member's name in their highest coloured Role's colour (ADR-0038, design
 * decision 12), mixed toward the theme's text colour so it reads at 4.5:1 or
 * better on both themes. With no coloured Role it is an ordinary name. Colour
 * is never the only signal: the Role's name is on the profile card.
 */
export function RoleTintedName({
  name,
  color,
  as = "strong"
}: {
  name: string;
  color: RoleColor | null;
  as?: "strong" | "span";
}) {
  const Tag = as;
  return (
    <Tag
      className={color ? "role-tinted" : undefined}
      style={color ? ({ "--role-color": color } as CSSProperties) : undefined}
    >
      {name}
    </Tag>
  );
}
