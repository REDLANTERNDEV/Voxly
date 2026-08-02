import type { FormEvent } from "react";
import { useState } from "react";
import { createServerInvite } from "../../api.js";
import type { Translate } from "../../app/types.js";
import { CopyIcon,PlusIcon } from "../../components/ui/Icons.js";
import { buildInviteUrl,resolveInviteOrigin } from "../../lib/invites.js";
import type { InviteExpiryMinutes,InviteMaxUses } from "../../types.js";
import { SecretLinkDisplay } from "../owner/OwnerServerContext.js";

export const inviteExpiryOptions: Array<{ value: InviteExpiryMinutes; key: "invite.expiry30m" | "invite.expiry1h" | "invite.expiry6h" | "invite.expiry12h" | "invite.expiry1d" | "invite.expiry7d" | "invite.expiry30d" | "common.noExpiry" }> = [
  { value: 30, key: "invite.expiry30m" },
  { value: 60, key: "invite.expiry1h" },
  { value: 360, key: "invite.expiry6h" },
  { value: 720, key: "invite.expiry12h" },
  { value: 1440, key: "invite.expiry1d" },
  { value: 10080, key: "invite.expiry7d" },
  { value: 43200, key: "invite.expiry30d" },
  { value: null, key: "common.noExpiry" }
];

export const inviteMaxUseOptions: InviteMaxUses[] = [1, 5, 10, 25, 50, 100, null];

/**
 * The single invite-creation surface. Owners reach it from the dashboard and
 * granted members from the rail, so both paths stay in step when the invite
 * options change.
 */
export function InviteComposer({ serverId, publicUrl, idPrefix, t, onCreated }: {
  serverId: string;
  publicUrl: string | null;
  idPrefix: string;
  t: Translate;
  onCreated?: () => void | Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState<InviteExpiryMinutes>(1440);
  const [maxUses, setMaxUses] = useState<InviteMaxUses>(1);
  const [created, setCreated] = useState<{ label: string; url: string } | null>(null);
  const [status, setStatus] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) {
      setStatus(t("owner.inviteLabelRequired"));
      return;
    }
    setIsBusy(true);
    setStatus("");
    try {
      const response = await createServerInvite(serverId, trimmed, expiry, maxUses);
      const origin = resolveInviteOrigin(publicUrl, window.location.origin);
      setCreated({ label: response.invite.label, url: buildInviteUrl(response.invite.token, origin) });
      setLabel("");
      setStatus(t("owner.created"));
      await onCreated?.();
    } catch {
      setStatus(t("invite.createFailed"));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <form className="invite-composer" onSubmit={submit}>
      <label className="form-field" htmlFor={`${idPrefix}Label`}>
        <span>{t("owner.inviteLabel")}</span>
        <input
          className="input"
          id={`${idPrefix}Label`}
          name="inviteLabel"
          value={label}
          maxLength={80}
          autoComplete="off"
          placeholder={t("owner.inviteLabelPlaceholder")}
          onChange={(event) => setLabel(event.currentTarget.value)}
        />
      </label>
      <div className="invite-composer-limits">
        <label className="form-field" htmlFor={`${idPrefix}Expiry`}>
          <span>{t("owner.expiresAfter")}</span>
          <select
            className="input"
            id={`${idPrefix}Expiry`}
            name="expiry"
            value={expiry ?? "never"}
            onChange={(event) => setExpiry(event.currentTarget.value === "never" ? null : Number(event.currentTarget.value) as InviteExpiryMinutes)}
          >
            {inviteExpiryOptions.map((option) => (
              <option key={option.value ?? "never"} value={option.value ?? "never"}>{t(option.key)}</option>
            ))}
          </select>
        </label>
        <label className="form-field" htmlFor={`${idPrefix}MaxUses`}>
          <span>{t("owner.maxUses")}</span>
          <select
            className="input"
            id={`${idPrefix}MaxUses`}
            name="maxUses"
            value={maxUses ?? "unlimited"}
            onChange={(event) => setMaxUses(event.currentTarget.value === "unlimited" ? null : Number(event.currentTarget.value) as InviteMaxUses)}
          >
            {inviteMaxUseOptions.map((count) => (
              <option key={count ?? "unlimited"} value={count ?? "unlimited"}>
                {count === null ? t("invite.unlimitedUses") : t("invite.useCount", { count })}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button className="btn btn-primary" type="submit" disabled={isBusy}>
        <PlusIcon />
        <span>{t("common.createInvite")}</span>
      </button>
      {created ? (
        <div className="invite-status is-valid">
          <strong>{t("owner.newInviteLink")}</strong>
          <span>{created.label}</span>
          <SecretLinkDisplay key={created.url} value={created.url} t={t} />
          <span className="muted small">{t("owner.newInviteLinkCopy")}</span>
          <button className="btn btn-ghost" type="button" onClick={async () => {
            try {
              await navigator.clipboard?.writeText(created.url);
              setStatus(t("owner.copied"));
            } catch {
              setStatus(t("owner.copyFailed"));
            }
          }}>
            <CopyIcon />
            <span>{t("common.copy")}</span>
          </button>
        </div>
      ) : null}
      <p className="muted small invite-composer-status" aria-live="polite">{status}</p>
    </form>
  );
}
