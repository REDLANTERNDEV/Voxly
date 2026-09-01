/**
 * A member's own Devices: what is signed in as them, and how they close one.
 *
 * Deliberately separate from the owner's session console in `ownerPanel.ts`,
 * which lists every session ever issued for every account and answers an
 * operator's question. This module answers a member's: *is that one mine, and
 * how do I get rid of it?* The two look alike and must not be merged — the
 * owner's view is a moderation tool, and this one is the only place a member
 * can act on their own account without asking anybody.
 *
 * It is also the half of [ADR-0014] that has to exist before anything can mint
 * a second Device. An account a member cannot inspect is one they cannot
 * defend, and both the Link code and the Recovery code depend on a member being
 * able to answer "was that me?".
 *
 * This module registers its own routes; `app.ts` composes it and hands it a
 * `RouteContext`. See
 * `docs/adr/0013-route-modules-register-their-own-routes.md`.
 */

import { z } from "zod";
import type { DeviceSummary } from "@voxly/shared";
import { audit } from "./audit.js";
import { devicesForUser, requireUser, revokeOwnDevice } from "./auth/sessions.js";
import { authenticatedWriteLimit, type RouteContext } from "./http.js";

const sessionIdParam = z.string().min(1);

/**
 * A bot has sessions but no Devices. It authenticates by an operator-held
 * credential (ADR-0003), its sessions are minted and retired by that exchange,
 * and a list it could sign itself out of is meaningless. Refused by the server
 * rather than merely absent from an interface no bot renders.
 */
function rejectBotCaller(isBot: boolean, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  if (!isBot) return false;
  reply.code(409).send({ error: "bot_has_no_devices" });
  return true;
}

export function registerDeviceRoutes({ fastify, database, realtime, secureCookies }: RouteContext) {
  fastify.get("/api/devices", async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    if (rejectBotCaller(user.isBot, reply)) return;
    const devices: DeviceSummary[] = devicesForUser(database.sqlite, user.id).map((row) => ({
      id: row.id,
      // Rows predating the column have no label, and a member still has to be
      // able to see and close them.
      label: row.label ?? "Unknown device",
      // Rows predating the column say "invite", which is what every session
      // before linking existed actually was.
      origin: row.origin ?? "invite",
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      current: row.id === user.sessionId
    }));
    return reply.send({ devices });
  });

  fastify.delete("/api/devices/:sessionId", { config: authenticatedWriteLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    if (rejectBotCaller(user.isBot, reply)) return;
    const parsed = z.object({ sessionId: sessionIdParam }).safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: "device_not_found" });

    // Signing out the Device you are using is logging out, which already exists
    // and also has to clear the cookie in front of you. Refusing here keeps one
    // way to end the current session rather than two that must agree.
    if (parsed.data.sessionId === user.sessionId) {
      return reply.code(400).send({ error: "cannot_revoke_current_device" });
    }
    if (!revokeOwnDevice(database, user.id, parsed.data.sessionId)) {
      return reply.code(404).send({ error: "device_not_found" });
    }

    audit(database, user.id, "device.revoked", user.id);
    database.save();
    // Revocation is only honoured when a request is authenticated again, so a
    // live socket would otherwise keep working on a session that is already
    // dead. This is what makes signing a Device out immediate rather than
    // eventual.
    realtime.disconnectDevice(user.id, parsed.data.sessionId);
    return reply.send({ ok: true });
  });
}
