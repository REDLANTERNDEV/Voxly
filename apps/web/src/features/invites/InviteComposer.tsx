import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { ApiError, createServerInvite } from "../../api.js";
import type { Translate } from "../../app/types.js";
import { CopyIcon, PlusIcon } from "../../components/ui/Icons.js";
import { buildInviteUrl, resolveInviteOrigin } from "../../lib/invites.js";
import type { InviteExpiryMinutes, InviteMaxUses } from "../../types.js";
import { SecretLinkDisplay } from "../owner/OwnerServerContext.js";

export const inviteExpiryOptions: Array<{
  value: InviteExpiryMinutes;
  key:
    | "invite.expiry30m"
    | "invite.expiry1h"
    | "invite.expiry6h"
    | "invite.expiry12h"
    | "invite.expiry1d"
    | "invite.expiry7d"
    | "invite.expiry30d"
    | "common.noExpiry";
}> = [
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
export function InviteComposer({
  serverId,
  publicUrl,
  idPrefix,
  t,
  onCreated
}: {
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
  const [statusIsError, setStatusIsError] = useState(false);
  const [nameInvalid, setNameInvalid] = useState(false);
  const statusId = `${idPrefix}Status`;
  function showError(message: string) {
    setStatus(message);
    setStatusIsError(true);
  }
  const [isBusy, setIsBusy] = useState(false);
  const copyRef = useRef<HTMLButtonElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const returningToForm = useRef(false);
  useEffect(() => {
    if (created) copyRef.current?.focus();
    else if (returningToForm.current) {
      nameRef.current?.focus();
      returningToForm.current = false;
    }
  }, [created]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) {
      setNameInvalid(true);
      showError(t("owner.inviteLabelRequired"));
      return;
    }
    setNameInvalid(false);
    setStatusIsError(false);
    setIsBusy(true);
    setStatus("");
    try {
      const response = await createServerInvite(serverId, trimmed, expiry, maxUses);
      const origin = resolveInviteOrigin(publicUrl, window.location.origin);
      setCreated({ label: response.invite.label, url: buildInviteUrl(response.invite.token, origin) });
      setLabel("");
      setStatus("");
      await onCreated?.();
    } catch (error) {
      // The server refuses a never-expiring link from a delegated inviter, and
      // caps how many links one member may have outstanding. Both are ordinary
      // outcomes for a non-owner, so name them rather than failing opaquely.
      const code = error instanceof ApiError ? error.code : undefined;
      if (code === "invite_expiry_required") {
        showError(t("invite.expiryRequired"));
      } else if (code === "invite_limit_reached") {
        showError(t("invite.limitReached"));
      } else {
        showError(t("invite.createFailed"));
      }
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <form className="invite-composer" onSubmit={submit}>
      {!created ? (
        <>
          <label className="form-field" htmlFor={`${idPrefix}Label`}>
            <span>{t("owner.inviteLabel")}</span>
            <input
              className="input"
              ref={nameRef}
              id={`${idPrefix}Label`}
              name="inviteLabel"
              aria-invalid={nameInvalid || undefined}
              aria-describedby={nameInvalid ? statusId : undefined}
              value={label}
              maxLength={80}
              autoComplete="off"
              placeholder={t("owner.inviteLabelPlaceholder")}
              onChange={(event) => {
                setLabel(event.currentTarget.value);
                if (nameInvalid) {
                  setNameInvalid(false);
                  setStatus("");
                  setStatusIsError(false);
                }
              }}
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
                onChange={(event) =>
                  setExpiry(
                    event.currentTarget.value === "never"
                      ? null
                      : (Number(event.currentTarget.value) as InviteExpiryMinutes)
                  )
                }
              >
                {inviteExpiryOptions.map((option) => (
                  <option key={option.value ?? "never"} value={option.value ?? "never"}>
                    {t(option.key)}
                  </option>
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
                onChange={(event) =>
                  setMaxUses(
                    event.currentTarget.value === "unlimited"
                      ? null
                      : (Number(event.currentTarget.value) as InviteMaxUses)
                  )
                }
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
        </>
      ) : null}
      {created ? (
        <div className="invite-created">
          <span className="invite-created-name">{created.label}</span>
          <SecretLinkDisplay key={created.url} value={created.url} t={t} />
          <span className="muted small">{t("invite.saveLink")}</span>
          <button
            ref={copyRef}
            className="btn btn-primary invite-copy"
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(created.url);
                setStatusIsError(false);
                setStatus(t("owner.copied"));
              } catch {
                showError(t("owner.copyFailed"));
              }
            }}
          >
            <CopyIcon />
            <span>{t("invite.copyLink")}</span>
          </button>
          <button
            className="btn btn-ghost invite-another"
            type="button"
            onClick={() => {
              returningToForm.current = true;
              setCreated(null);
              setStatus("");
            }}
          >
            {t("invite.createAnother")}
          </button>
        </div>
      ) : null}
      <p
        id={statusId}
        className={`small invite-composer-status ${statusIsError ? "is-error" : "muted"}`}
        aria-live="polite"
      >
        {status}
      </p>
    </form>
  );
}
