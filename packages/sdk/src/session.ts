/**
 * The SDK recording session: buffers captured entries, redacts them, and hands
 * the result to the shared package writer.
 *
 * Structure mirrors the extension's pipeline on purpose — capture, redact at
 * the boundary, buffer, package — because the output has to be a package the
 * player and the MCP tools already understand. What differs is only what can be
 * captured at all: no tab video, no cross-origin response bodies, no CDP.
 *
 * Redaction runs as entries arrive, never at packaging time. A buffer that
 * briefly held unredacted values would be one `console.log` of the session
 * object away from leaking them.
 */

import type { SerializedDomNode } from "../../replay-core/src/capture/dom-snapshot";
import {
  type InPageCaptureScope,
  installInPageCapture,
} from "../../replay-core/src/capture/in-page-capture";
import {
  type InstantReplayOptions,
  type InstantReplayRecorder,
  startInstantReplay,
} from "../../replay-core/src/capture/instant-replay";
import {
  buildRecordingPrivacySummary,
  getPrivacyProfileSettings,
  redactConsoleEntry,
  redactHeaderMap,
  redactUrl,
  redactUserEvent,
} from "../../replay-core/src/redact/privacy-redaction";
import {
  type PrivacyProfile,
  type PrivacyRedactionSettings,
  SDK_CAPABILITIES,
} from "../../replay-core/src/schema";
import type { Screenshot } from "../../replay-core/src/schema/annotation";
import type {
  ConsoleEntry,
  NetworkEntry,
  RecordingPrivacySummary,
  RecordingUserEvent,
  RedactionHit,
  StorageSnapshot,
  WebSocketEntry,
} from "../../replay-core/src/schema/capture";
import {
  type AttachableArtifactId,
  type BuiltPackage,
  buildAgentSummaryArtifact,
  buildRecordingPackage,
  encodeJsonArtifact,
} from "../../replay-core/src/write";
import { type CaptureScreenshotOptions, captureScreenshot } from "./screenshot";
import { installUserEventCapture } from "./user-events";

export interface SessionLimits {
  /** Hard cap per artifact. Oldest entries are dropped first. */
  maxConsoleEntries: number;
  maxNetworkEntries: number;
  maxWebSocketEntries: number;
  maxUserEvents: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  maxConsoleEntries: 5_000,
  maxNetworkEntries: 5_000,
  maxWebSocketEntries: 2_000,
  maxUserEvents: 5_000,
};

export interface SessionOptions {
  /** Window to instrument. Defaults to the ambient one. */
  window?: Window;
  /** Privacy profile driving redaction. Defaults to `standard`. */
  privacyProfile?: PrivacyProfile;
  /** Overrides on top of the profile's settings. */
  privacySettings?: Partial<PrivacyRedactionSettings>;
  limits?: Partial<SessionLimits>;
  captureUserEvents?: boolean;
  captureStorage?: boolean;
  /** Password for the produced package. Empty means unprotected. */
  password?: string;
  /**
   * Keep a rolling pre-bug buffer so a reporter never has to reproduce the
   * problem. Off by default: it snapshots the DOM on a timer, which is real
   * work on the host's page and should be an explicit choice.
   */
  instantReplay?: boolean | InstantReplayOptions;
}

/**
 * A bounded FIFO. Dropping the oldest entries keeps a long session from growing
 * without limit, and the count of what was dropped is reported as a privacy
 * limitation so a reader is never silently shown a partial log.
 */
class BoundedBuffer<T> {
  #items: T[] = [];
  #dropped = 0;

  constructor(private readonly limit: number) {}

  push(item: T): void {
    this.#items.push(item);
    while (this.#items.length > this.limit) {
      this.#items.shift();
      this.#dropped += 1;
    }
  }

  get items(): T[] {
    return this.#items;
  }

  get dropped(): number {
    return this.#dropped;
  }

  get length(): number {
    return this.#items.length;
  }
}

export interface StopResult {
  package: BuiltPackage;
  /** Convenience view for hosts that just want to upload the bytes. */
  blob: Blob;
  filename: string;
}

export class RecordingSession {
  readonly startTime: number;
  readonly #settings: PrivacyRedactionSettings;
  readonly #limits: SessionLimits;
  readonly #options: SessionOptions;
  readonly #window: Window;

  readonly #console: BoundedBuffer<ConsoleEntry>;
  readonly #network: BoundedBuffer<NetworkEntry>;
  readonly #websocket: BoundedBuffer<WebSocketEntry>;
  readonly #events: BoundedBuffer<RecordingUserEvent>;
  readonly #storage: StorageSnapshot[] = [];
  readonly #hits: RedactionHit[] = [];
  readonly #screenshots: Screenshot[] = [];
  /** Backing snapshots for `screenshots`, written out as `dom.json`. */
  readonly #domSnapshots: Array<{
    label: string;
    capturedAt: number;
    documentUrl: string;
    root: SerializedDomNode;
  }> = [];

  #teardown: Array<() => void> = [];
  #instantReplay: InstantReplayRecorder | null = null;
  #stopped = false;

  constructor(options: SessionOptions = {}) {
    const ambient = options.window ?? (globalThis as unknown as { window?: Window }).window;
    if (!ambient) {
      throw new Error("GN Tracing SDK requires a browser window.");
    }
    this.#window = ambient;
    this.#options = options;
    this.startTime = Date.now();
    this.#settings = {
      ...getPrivacyProfileSettings(options.privacyProfile ?? "standard"),
      ...options.privacySettings,
    };
    this.#limits = { ...DEFAULT_SESSION_LIMITS, ...options.limits };
    this.#console = new BoundedBuffer(this.#limits.maxConsoleEntries);
    this.#network = new BoundedBuffer(this.#limits.maxNetworkEntries);
    this.#websocket = new BoundedBuffer(this.#limits.maxWebSocketEntries);
    this.#events = new BoundedBuffer(this.#limits.maxUserEvents);
  }

  /** Installs every patch and listener. Idempotent per instance. */
  start(): void {
    if (this.#teardown.length > 0 || this.#stopped) {
      return;
    }

    const scope = this.#window as unknown as InPageCaptureScope;
    this.#teardown.push(
      installInPageCapture(scope, "sdk-session", (_sessionId, kind, entry) => {
        this.#ingest(kind, entry);
      }),
    );

    if (this.#options.captureUserEvents !== false) {
      this.#teardown.push(
        installUserEventCapture(this.#window, (event) => this.#ingestUserEvent(event), {
          maskSelectors: this.#settings.maskDomSelectors,
        }),
      );
    }

    if (this.#options.instantReplay) {
      const replayOptions =
        typeof this.#options.instantReplay === "object" ? this.#options.instantReplay : {};
      this.#instantReplay = startInstantReplay(
        this.#window as unknown as Parameters<typeof startInstantReplay>[0],
        {
          maskSelectors: this.#settings.maskDomSelectors,
          ...replayOptions,
        },
      );
      this.#teardown.push(() => this.#instantReplay?.stop());
    }
  }

  /**
   * Captures what the page looks like now, as a DOM snapshot the player
   * re-renders. Annotations may be supplied here or attached later with
   * `annotateScreenshot`.
   *
   * Returns the entry's id so a host's own annotation UI can address it.
   */
  captureScreenshot(options: CaptureScreenshotOptions = {}): string {
    if (this.#stopped) {
      throw new Error("Cannot capture a screenshot after the session has stopped.");
    }

    const captured = captureScreenshot(this.#window, this.#domSnapshots.length, {
      maskSelectors: this.#settings.maskDomSelectors,
      ...options,
    });

    this.#domSnapshots.push({
      label: `screenshot:${captured.screenshot.id}`,
      capturedAt: captured.screenshot.capturedAt,
      documentUrl: captured.screenshot.url ?? "",
      root: captured.domRoot,
    });
    this.#screenshots.push(captured.screenshot);
    return captured.screenshot.id;
  }

  /** Replaces the annotations on a previously captured screenshot. */
  annotateScreenshot(screenshotId: string, annotations: Screenshot["annotations"]): void {
    const target = this.#screenshots.find((screenshot) => screenshot.id === screenshotId);
    if (!target) {
      throw new Error(`No screenshot with id ${screenshotId} in this session.`);
    }
    // A DOM-snapshot screenshot has no pixels to destroy, so a `redact` shape
    // here is honoured by the *serializer's* mask selectors, not by baking. Say
    // so rather than letting a caller believe a pending redaction was applied.
    for (const annotation of annotations) {
      if (annotation.type === "redact" && annotation.applied === "pending") {
        throw new Error(
          "The SDK cannot bake a redaction into a DOM snapshot. Pass the region's selector as a mask selector before capturing instead.",
        );
      }
    }
    target.annotations = annotations;
  }

  /** Screenshots captured so far, for a host building its own editor UI. */
  get screenshots(): readonly Screenshot[] {
    return this.#screenshots;
  }

  /** Null when instant replay is off or has disabled itself. */
  get instantReplayStatus(): { enabled: boolean; disabledReason: string | null } {
    return {
      enabled: this.#instantReplay !== null && !this.#instantReplay.disabled,
      disabledReason: this.#instantReplay?.disabledReason ?? null,
    };
  }

  /**
   * Restores every patched global and builds the package. Safe to call twice;
   * the second call throws rather than producing a second, emptier package.
   */
  async stop(): Promise<StopResult> {
    if (this.#stopped) {
      throw new Error("This recording session has already been stopped.");
    }
    this.#stopped = true;

    // Reverse order so each global returns to the exact reference it had.
    for (let index = this.#teardown.length - 1; index >= 0; index -= 1) {
      this.#teardown[index]();
    }
    this.#teardown = [];

    const packagedAt = new Date().toISOString();
    const stopTime = Date.now();
    const zipFilename = `gn-tracing-${packagedAt.replace(/[:.]/g, "-").slice(0, 19)}.zip`;

    const artifacts: Partial<Record<AttachableArtifactId, Uint8Array>> = {};
    if (this.#console.length > 0) {
      artifacts.console = encodeJsonArtifact(this.#console.items);
    }
    if (this.#network.length > 0) {
      artifacts.network = encodeJsonArtifact(this.#network.items);
    }
    if (this.#websocket.length > 0) {
      artifacts.websocket = encodeJsonArtifact(this.#websocket.items);
    }
    if (this.#events.length > 0) {
      artifacts.events = encodeJsonArtifact({ schemaVersion: 1, events: this.#events.items });
    }
    if (this.#options.captureStorage !== false && this.#storage.length > 0) {
      artifacts.storage = encodeJsonArtifact({ schemaVersion: 1, snapshots: this.#storage });
    }
    if (this.#screenshots.length > 0) {
      artifacts.screenshots = encodeJsonArtifact({
        schemaVersion: 1,
        screenshots: this.#screenshots,
      });
      // The screenshots reference these by index, so the two artifacts are only
      // meaningful together.
      artifacts.dom = encodeJsonArtifact({ schemaVersion: 1, snapshots: this.#domSnapshots });
    }
    const instantReplay = this.#instantReplay?.toArtifact() ?? null;
    if (instantReplay) {
      artifacts.instantReplay = encodeJsonArtifact(instantReplay);
    }
    artifacts.privacy = encodeJsonArtifact(this.#buildPrivacySummary(packagedAt, artifacts));

    const metadataPreview = {
      timestamp: packagedAt,
      duration: (stopTime - this.startTime) / 1000,
      url: this.#window.location?.href,
      startTime: this.startTime,
      producer: "sdk" as const,
      capabilities: SDK_CAPABILITIES,
    };
    const agentSummary = buildAgentSummaryArtifact({
      metadata: metadataPreview,
      console: artifacts.console,
      network: artifacts.network,
      websocket: artifacts.websocket,
      events: artifacts.events,
      privacy: artifacts.privacy,
      availableArtifacts: ["metadata", ...Object.keys(artifacts)],
      generatedAt: packagedAt,
    });
    if (agentSummary) {
      artifacts.agentSummary = agentSummary;
    }

    const built = await buildRecordingPackage({
      producer: "sdk",
      capabilities: SDK_CAPABILITIES,
      packagedAt,
      zipFilename,
      duration: metadataPreview.duration,
      url: metadataPreview.url,
      startTime: this.startTime,
      artifacts,
      password: this.#options.password,
      modifiedAt: new Date(stopTime),
    });

    return {
      package: built,
      blob: new Blob(built.chunks as BlobPart[], { type: "application/zip" }),
      filename: zipFilename,
    };
  }

  #ingest(
    kind: "console" | "network" | "websocket" | "storage",
    entry: ConsoleEntry | NetworkEntry | WebSocketEntry | StorageSnapshot,
  ): void {
    switch (kind) {
      case "console": {
        const result = redactConsoleEntry(entry as ConsoleEntry, this.#settings);
        this.#hits.push(...result.applied);
        this.#console.push(result.value);
        break;
      }
      case "network": {
        this.#network.push(this.#redactNetworkEntry(entry as NetworkEntry));
        break;
      }
      case "websocket": {
        this.#websocket.push(entry as WebSocketEntry);
        break;
      }
      case "storage": {
        if (this.#options.captureStorage !== false) {
          this.#storage.push(entry as StorageSnapshot);
        }
        break;
      }
    }
  }

  #ingestUserEvent(event: RecordingUserEvent): void {
    const result = redactUserEvent(event, this.#settings);
    this.#hits.push(...result.applied);
    this.#events.push(result.value);
  }

  /** URL and header redaction, matching what the service worker applies. */
  #redactNetworkEntry(entry: NetworkEntry): NetworkEntry {
    const url = redactUrl(entry.url, this.#settings);
    const requestHeaders = redactHeaderMap(entry.requestHeaders, this.#settings, "headers");
    const responseHeaders = redactHeaderMap(entry.responseHeaders, this.#settings, "headers");
    this.#hits.push(...url.applied, ...requestHeaders.applied, ...responseHeaders.applied);
    return {
      ...entry,
      url: url.value ?? entry.url,
      requestHeaders: requestHeaders.value,
      responseHeaders: responseHeaders.value,
    };
  }

  /**
   * The privacy artifact records both what was redacted and what the SDK simply
   * could not see, so a reader does not read an absent artifact as an absent
   * problem.
   */
  #buildPrivacySummary(
    createdAt: string,
    artifacts: Partial<Record<AttachableArtifactId, Uint8Array>>,
  ): RecordingPrivacySummary {
    const limitations = [
      "Captured by the in-page SDK: no tab video was recorded.",
      "Only the embedding origin is visible; cross-origin request and response detail is not captured.",
      "Console stacks are not resolved through source maps.",
    ];
    if (this.#screenshots.length > 0) {
      limitations.push(
        "Screenshots are re-rendered DOM snapshots, not raster captures: canvas contents, cross-origin iframes, and video frames are not reproduced.",
      );
    }
    if (this.#instantReplay?.disabled && this.#instantReplay.disabledReason) {
      limitations.push(this.#instantReplay.disabledReason);
    }
    for (const [label, buffer] of [
      ["console", this.#console],
      ["network", this.#network],
      ["websocket", this.#websocket],
      ["user event", this.#events],
    ] as const) {
      if (buffer.dropped > 0) {
        limitations.push(
          `${buffer.dropped} oldest ${label} entries were dropped at the buffer cap.`,
        );
      }
    }

    return buildRecordingPrivacySummary(
      this.#settings,
      {
        video: false,
        screenshot: artifacts.screenshots !== undefined,
        report: false,
        events: artifacts.events !== undefined,
        console: artifacts.console !== undefined,
        network: artifacts.network !== undefined,
        websocket: artifacts.websocket !== undefined,
        requestBodies: false,
        responseBodies: false,
        websocketPayloads: false,
        sourceSnippets: false,
        storage: artifacts.storage !== undefined,
        dom: artifacts.dom !== undefined || artifacts.instantReplay !== undefined,
      },
      this.#hits,
      limitations,
      createdAt,
    );
  }
}
