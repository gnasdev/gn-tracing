/**
 * The keepalive must be armed BEFORE the start path waits for the user.
 *
 * On Firefox the background is an event page (`background.scripts` in the
 * patched manifest), which the browser unloads when idle and re-evaluates from
 * scratch on the next event. The Firefox start path blocks waiting for the user
 * to pick a share target in the arm panel — up to 180s (ARM_TIMEOUT_MS) during
 * which the background does nothing.
 *
 * If the event page unloads in that window, the suspended `await
 * recordingRuntime.start(...)` continuation is destroyed. Everything after it
 * never runs: the in-page capture START message is never sent, so console and
 * network evidence stay completely empty — while the video records fine, because
 * the MediaRecorder lives in the media tab, not in the background. That is
 * exactly the reported "video works but console.json is empty" failure.
 *
 * Chrome never exhibited it: its evidence arrives over CDP, and that steady
 * event traffic keeps the service worker alive without any help.
 *
 * These assertions read the real ordering out of the production source because
 * the defect IS an ordering property of one function. They are written to fail
 * if the alarm is moved back after the start call.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const swSource = readFileSync(resolve(__dirname, "service-worker.ts"), "utf8");

const KEEPALIVE_CREATE = 'chrome.alarms.create("gn-tracing-keepalive"';
const RUNTIME_START = "await recordingRuntime.start({";

describe("recording keepalive ordering", () => {
  it("arms the keepalive before awaiting the recording runtime start", () => {
    const alarmAt = swSource.indexOf(KEEPALIVE_CREATE);
    const startAt = swSource.indexOf(RUNTIME_START);

    expect(alarmAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(-1);
    // The whole point: create < start. Reversing this reintroduces the bug.
    expect(alarmAt).toBeLessThan(startAt);
  });

  it("arms it after the pre-injection so a failed injection does not leave an alarm", () => {
    const preinjectAt = swSource.indexOf("await preinjectRecordedTabScripts(tabId);");
    const alarmAt = swSource.indexOf(KEEPALIVE_CREATE);
    expect(preinjectAt).toBeGreaterThan(-1);
    expect(preinjectAt).toBeLessThan(alarmAt);
  });

  it("clears the keepalive on the start failure path", () => {
    // Armed before the wait means every failure path owns clearing it, or a
    // cancelled start wakes the event page every 24s forever.
    const catchAt = swSource.indexOf("await stopRecordingEventCapture(tabId);\n    try {");
    expect(catchAt).toBeGreaterThan(-1);
    const beforeCatch = swSource.slice(Math.max(0, catchAt - 400), catchAt);
    expect(beforeCatch).toContain('chrome.alarms.clear("gn-tracing-keepalive")');
  });

  it("does not gate the keepalive handler on isRecording", () => {
    // isRecording is only set AFTER the user picks a share target, which is the
    // exact window the keepalive exists to protect. Gating on it made the
    // handler a no-op precisely when it was needed.
    const handlerAt = swSource.indexOf("chrome.alarms.onAlarm.addListener(");
    expect(handlerAt).toBeGreaterThan(-1);
    const handler = swSource.slice(handlerAt, handlerAt + 900);
    expect(handler).toContain('alarm.name !== "gn-tracing-keepalive"');
    expect(handler).not.toContain("&& activeRecording.isRecording");
  });

  it("keeps the alarm period inside the event-page idle timeout", () => {
    // Firefox unloads an idle event page at ~30s; the alarm must fire sooner.
    const match = swSource.match(/gn-tracing-keepalive",\s*\{\s*periodInMinutes:\s*([\d.]+)\s*\}/);
    expect(match).not.toBeNull();
    const periodSeconds = Number(match?.[1]) * 60;
    expect(periodSeconds).toBeLessThan(30);
  });
});
