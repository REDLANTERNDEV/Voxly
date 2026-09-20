import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notificationReducer, type AppNotificationInput } from "../src/lib/notifications.js";

const voiceFailure: AppNotificationInput = {
  id: "voice-error:voiceError.join",
  tone: "danger",
  titleKey: "notification.voiceErrorTitle",
  messageKey: "voiceError.join",
  timeoutMs: null,
  action: "open-audio-settings"
};

describe("application notifications", () => {
  it("adds a new notification with one occurrence", () => {
    const state = notificationReducer([], { type: "push", notification: voiceFailure });

    assert.deepEqual(state, [{ ...voiceFailure, occurrences: 1, revision: 1 }]);
  });

  it("groups a repeated failure and advances its revision", () => {
    const first = notificationReducer([], { type: "push", notification: voiceFailure });
    const repeated = notificationReducer(first, { type: "push", notification: voiceFailure });

    assert.equal(repeated.length, 1);
    assert.equal(repeated[0]?.occurrences, 2);
    assert.equal(repeated[0]?.revision, 2);
  });

  it("ignores an expiry left behind by an earlier occurrence", () => {
    const transient: AppNotificationInput = {
      id: "voice-notice:voiceNotice.joinedAnotherDevice",
      tone: "neutral",
      titleKey: "notification.voiceNoticeTitle",
      messageKey: "voiceNotice.joinedAnotherDevice",
      timeoutMs: 5_200
    };
    const first = notificationReducer([], { type: "push", notification: transient });
    const repeated = notificationReducer(first, { type: "push", notification: transient });

    const staleExpiry = notificationReducer(repeated, { type: "expire", id: transient.id, revision: 1 });
    assert.equal(staleExpiry.length, 1);

    const currentExpiry = notificationReducer(staleExpiry, { type: "expire", id: transient.id, revision: 2 });
    assert.deepEqual(currentExpiry, []);
  });

  it("dismisses only the selected notification", () => {
    const notice: AppNotificationInput = {
      id: "voice-notice:voiceNotice.ownerDisconnect",
      tone: "neutral",
      titleKey: "notification.voiceNoticeTitle",
      messageKey: "voiceNotice.ownerDisconnect",
      timeoutMs: 5_200
    };
    const withFailure = notificationReducer([], { type: "push", notification: voiceFailure });
    const withBoth = notificationReducer(withFailure, { type: "push", notification: notice });

    const dismissed = notificationReducer(withBoth, { type: "dismiss", id: voiceFailure.id });
    assert.deepEqual(dismissed.map((item) => item.id), [notice.id]);
  });

  it("does not let a stale close animation dismiss a repeated notification", () => {
    const first = notificationReducer([], { type: "push", notification: voiceFailure });
    const repeated = notificationReducer(first, { type: "push", notification: voiceFailure });

    const staleDismissal = notificationReducer(repeated, { type: "dismiss", id: voiceFailure.id, revision: 1 });
    assert.equal(staleDismissal[0]?.revision, 2);

    const currentDismissal = notificationReducer(staleDismissal, { type: "dismiss", id: voiceFailure.id, revision: 2 });
    assert.deepEqual(currentDismissal, []);
  });
});
