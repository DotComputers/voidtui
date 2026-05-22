#!/usr/bin/env bun
import { VoidScene } from "./scene.ts";
import { Ambient } from "./ambient.ts";
import { PostsLayer } from "./posts.ts";
import { InputHandler } from "./input.ts";
import { NetworkClient } from "./network.ts";
import { suggestHandle } from "./identity.ts";
import { initAccentFromConfig } from "./accent.ts";
import { ModalLayer } from "./modals/index.ts";
import { HelpModal } from "./modals/help.ts";
import { ConfigModal } from "./modals/config.ts";
import { LaunchBrowserModal } from "./modals/launch-browser.ts";
import { DONATE_URL, MERCH_URL } from "./constants.ts";
import { runUpdate, detectPlatform } from "./updater.ts";
import { CLIENT_VERSION } from "./version.ts";
import { UpdateModal, ProtocolMismatchModal } from "./modals/update.ts";

const SERVER_URL = process.env.VOID_SERVER ?? "wss://api.void-relay.com";
const MANIFEST_URL = process.env.VOID_MANIFEST_URL ?? "https://void-relay.com/release/latest.json";
const HANDLE_REGEX = /^[a-z0-9_-]{3,20}$/;

async function main(): Promise<void> {
  // Load persisted accent before scene init so first render uses saved color.
  await initAccentFromConfig();

  const scene = new VoidScene();
  await scene.init();

  const ambient = new Ambient(scene.renderer, scene.voidSurface);
  ambient.start();

  const posts = new PostsLayer(scene.renderer, scene.voidSurface);

  const modals = new ModalLayer(scene, ambient, posts);

  const network = new NetworkClient(SERVER_URL);

  // First-run: show the handle picker, loop on rejection until accepted.
  if (!(await network.hasSavedIdentity())) {
    await runFirstRunPicker(scene, network);
  }

  // Network → Scene state
  network.on("status", (status) => {
    scene.setConnected(status === "connected");
  });
  network.on("handle", (handle) => {
    scene.setHandle(handle);
  });
  network.on("activeCount", (count) => {
    scene.setActiveCount(count);
  });

  // Network → void feed
  network.on("broadcast", (post) => {
    posts.spawnPost({
      handle: post.handle,
      body: post.body,
      ghost: post.ghost,
    });
  });
  network.on("ownPost", (post) => {
    posts.spawnPost({
      handle: post.handle,
      body: post.body,
      ghost: post.ghost,
    });
  });

  network.on("rejected", (reason, message) => {
    if (reason === "protocol_mismatch") {
      modals.mount(new ProtocolMismatchModal());
      return;
    }
    // For other rejections (e.g. banned, server-full) just log; the steady-state
    // reconnect loop will keep retrying.
    console.error(`[void] connect rejected: ${reason} — ${message}`);
  });

  await network.start();

  // Background auto-update: fire-and-forget. The current session keeps running
  // on the old binary; next launch picks up any update we install.
  const platform = detectPlatform();
  if (platform) {
    void runUpdate({
      manifestUrl: MANIFEST_URL,
      currentVersion: CLIENT_VERSION,
      execPath: process.execPath,
      platform,
    });
  }

  // Input → Network
  const input = new InputHandler(
    scene.renderer,
    scene,
    (submission) => {
      network.sendPost({ body: submission.body, ghost: submission.ghost });
    },
    (command) => {
      switch (command) {
        case "help":
          modals.mount(new HelpModal());
          break;
        case "config":
          modals.mount(new ConfigModal());
          break;
        case "donate":
          modals.mount(new LaunchBrowserModal({
            url: DONATE_URL,
            headline: "thanks for keeping the void alive",
          }));
          break;
        case "merch":
          modals.mount(new LaunchBrowserModal({
            url: MERCH_URL,
            headline: "wear the void",
          }));
          break;
        case "update":
          modals.mount(new UpdateModal());
          break;
        case "quit":
          void gracefulExit(network, scene, 0);
          break;
      }
    },
  );
  input.start();

  process.on("SIGINT", () => {
    void gracefulExit(network, scene, 0);
  });
  process.on("SIGTERM", () => {
    void gracefulExit(network, scene, 0);
  });
}

let _shuttingDown = false;
async function gracefulExit(
  network: NetworkClient,
  scene: VoidScene,
  code = 0,
): Promise<never> {
  if (_shuttingDown) process.exit(code);
  _shuttingDown = true;
  try {
    await network.close();
  } catch {
    // ignore
  }
  try {
    scene.destroy();
  } catch {
    // ignore
  }
  process.exit(code);
}

async function runFirstRunPicker(
  scene: VoidScene,
  network: NetworkClient,
): Promise<void> {
  scene.showPicker();

  return new Promise<void>((resolve) => {
    const keyInput = (
      scene.renderer as unknown as {
        keyInput: {
          on: (event: string, cb: (e: KeypressEvent) => void) => void;
          off: (event: string, cb: (e: KeypressEvent) => void) => void;
        };
      }
    ).keyInput;

    let mode: "edit" | "random" = "edit";
    let currentRandom = "";

    const finish = (): void => {
      keyInput.off("keypress", onKey);
      scene.hidePicker();
      resolve();
    };

    const attempt = async (handle: string): Promise<void> => {
      const normalized = handle.trim().toLowerCase();
      if (!HANDLE_REGEX.test(normalized)) {
        scene.setPickerError("3-20 chars, a-z 0-9 _ -");
        return;
      }
      scene.setPickerError("verifying...");
      const result = await network.tryRegister(normalized);
      if (result.ok) {
        finish();
        return;
      }
      const msg =
        result.reason === "handle_taken"
          ? "that one is taken. try another."
          : result.reason === "invalid_pow"
          ? "proof-of-work rejected. try again."
          : result.reason === "connection_error" ||
            result.reason === "timeout"
          ? "can't reach the void. is the server running?"
          : result.message;
      scene.setPickerError(msg);
    };

    // Submit-from-textarea (edit mode Enter).
    scene.onPickerSubmit((raw) => {
      if (mode === "edit") attempt(raw);
    });

    const enterRandom = (): void => {
      currentRandom = suggestHandle();
      scene.setPickerRandom(currentRandom);
      scene.setPickerError("");
      scene.setPickerMode("random");
      mode = "random";
    };

    const onKey = (event: KeypressEvent): void => {
      if (event.eventType === "release") return;

      // Tab — always cycle to a new random and enter/stay in random mode.
      if (event.name === "tab" && !event.ctrl && !event.meta && !event.shift) {
        enterRandom();
        return;
      }

      // In random mode, intercept other keys.
      if (mode === "random") {
        if (event.name === "return" || event.name === "enter" || event.name === "kpenter") {
          attempt(currentRandom);
          return;
        }
        if (event.name === "escape") {
          scene.setPickerInputText("");
          scene.setPickerMode("edit");
          mode = "edit";
          return;
        }
        // Any printable char: switch to edit and seed the textarea with it.
        const seq = event.sequence;
        if (seq && seq.length === 1 && /^[a-z0-9_-]$/i.test(seq)) {
          scene.setPickerInputText(seq.toLowerCase());
          scene.setPickerMode("edit");
          mode = "edit";
          return;
        }
        // Otherwise: swallow.
      }
    };
    keyInput.on("keypress", onKey);
  });
}

// Looser key event shape; matches input.ts since the type isn't cleanly
// re-exported from the package root.
type KeypressEvent = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option: boolean;
  sequence: string;
  raw: string;
  eventType: "press" | "repeat" | "release";
};

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
