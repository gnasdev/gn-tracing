import {
  classifyAudioInputPermissionFailure,
  MICROPHONE_PERMISSION_RESULT_KEY,
  type MicrophonePermissionResult,
} from "../shared/microphone-permission";
import { getUiLanguage, type UiLanguage } from "../shared/ui-language";

const COPY: Record<UiLanguage, Record<string, string>> = {
  en: {
    title: "Allow microphone access",
    lead: "GN Tracing needs microphone access to list your audio inputs and include your voice in a recording.",
    allow: "Allow microphone",
    note: "Chrome may show a permission prompt after you select Allow microphone.",
    close: "Close this page",
    requesting: "Requesting microphone access…",
    granted: "Microphone access is enabled. Return to GN Tracing Devices to choose an input.",
    denied:
      "Microphone access was dismissed or denied. Check Chrome and macOS settings, then try again.",
    unavailable: "No microphone input is available. Connect or enable one, then try again.",
    busy: "Your microphone is busy in another app. Close that app, then try again.",
    unknown: "Could not access the microphone. Try again.",
  },
  vi: {
    title: "Cho phép truy cập micrô",
    lead: "GN Tracing cần quyền micrô để liệt kê đầu vào âm thanh và ghi giọng nói của bạn.",
    allow: "Cho phép micrô",
    note: "Chrome có thể hiển thị yêu cầu quyền sau khi bạn chọn Cho phép micrô.",
    close: "Đóng trang này",
    requesting: "Đang yêu cầu quyền micrô…",
    granted: "Quyền micrô đã bật. Hãy quay lại Thiết bị của GN Tracing để chọn đầu vào.",
    denied: "Quyền micrô đã bị đóng hoặc từ chối. Hãy kiểm tra Chrome và macOS rồi thử lại.",
    unavailable: "Không có đầu vào micrô khả dụng. Hãy kết nối hoặc bật micrô rồi thử lại.",
    busy: "Micrô đang được ứng dụng khác dùng. Hãy đóng ứng dụng đó rồi thử lại.",
    unknown: "Không thể truy cập micrô. Hãy thử lại.",
  },
};

const language = getUiLanguage();

function t(key: string): string {
  return COPY[language][key] ?? COPY.en[key] ?? key;
}

function applyTranslations(): void {
  document.documentElement.lang = language;
  document.title = `${t("title")} — GN Tracing`;
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    if (key) {
      element.textContent = t(key);
    }
  });
}

const allowMicrophoneButton = document.getElementById("allow-microphone-btn") as HTMLButtonElement;
const closePageButton = document.getElementById("close-page-btn") as HTMLButtonElement;
const permissionStatus = document.getElementById("permission-status") as HTMLElement;

function setStatus(message: string, state: "idle" | "success" | "error" = "idle"): void {
  permissionStatus.textContent = message;
  permissionStatus.dataset.state = state;
}

async function saveResult(result: MicrophonePermissionResult): Promise<void> {
  await chrome.storage.session.set({ [MICROPHONE_PERMISSION_RESULT_KEY]: result });
}

async function requestMicrophoneAccess(): Promise<void> {
  allowMicrophoneButton.disabled = true;
  setStatus(t("requesting"));

  if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices.enumerateDevices) {
    const result: MicrophonePermissionResult = {
      ok: false,
      error: "Microphone access is unavailable in this extension page.",
      audioInputFailure: "unavailable",
    };
    await saveResult(result);
    setStatus(t("unavailable"), "error");
    allowMicrophoneButton.disabled = false;
    return;
  }

  try {
    // This call is deliberately made in this page's click handler so Chrome sees a visible origin and direct user gesture.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => {
      track.stop();
    });
    const devices = await navigator.mediaDevices.enumerateDevices();
    await saveResult({
      ok: true,
      audioDevices: devices.map((device) => ({
        kind: device.kind,
        deviceId: device.deviceId,
        label: device.label,
      })),
    });
    setStatus(t("granted"), "success");
  } catch (error) {
    const failure = classifyAudioInputPermissionFailure(error);
    await saveResult({
      ok: false,
      error: error instanceof Error ? error.message : "Could not access the microphone.",
      audioInputFailure: failure,
    });
    setStatus(t(failure), "error");
    allowMicrophoneButton.disabled = false;
  }
}

allowMicrophoneButton.addEventListener("click", () => {
  void requestMicrophoneAccess();
});

closePageButton.addEventListener("click", () => {
  window.close();
});

applyTranslations();
