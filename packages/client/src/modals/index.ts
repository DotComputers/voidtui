import { BoxRenderable, type CliRenderer } from "@opentui/core";
import type { Ambient } from "../ambient.ts";
import type { PostsLayer } from "../posts.ts";
import type { VoidScene } from "../scene.ts";

/**
 * A modal "owns" a single BoxRenderable that takes over the void surface.
 * When mounted, ambient + posts are paused and the compose row is hidden.
 * When unmounted (Esc, or explicit dismiss), the modal cleans up and the
 * void resumes.
 */
export interface Modal {
  /** Add child renderables to this container; sized to the void surface. */
  mount(container: BoxRenderable, ctx: ModalContext): void;
  /** Called when the modal is dismissed (cleanup own listeners/timers). */
  unmount(): void;
  /** Called on every keypress while this modal is mounted. Return true if handled. */
  onKey(event: ModalKeyEvent): boolean;
}

export type ModalContext = {
  scene: VoidScene;
  renderer: CliRenderer;
  /** Call to dismiss this modal and return to the void. */
  dismiss: () => void;
};

export type ModalKeyEvent = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence: string;
  eventType: "press" | "repeat" | "release";
};

export class ModalLayer {
  private scene: VoidScene;
  private ambient: Ambient;
  private posts: PostsLayer;
  private current: Modal | null = null;
  private container: BoxRenderable | null = null;
  private keyHandler: ((e: ModalKeyEvent) => void) | null = null;

  constructor(scene: VoidScene, ambient: Ambient, posts: PostsLayer) {
    this.scene = scene;
    this.ambient = ambient;
    this.posts = posts;
  }

  isMounted(): boolean {
    return this.current !== null;
  }

  mount(modal: Modal): void {
    if (this.current) this.unmount();

    this.ambient.setPaused(true);
    this.posts.setPaused(true);
    this.scene.hideCompose();

    this.container = new BoxRenderable(this.scene.renderer, {
      id: "modal-container",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      zIndex: 200,
    });
    this.scene.voidSurface.add(this.container);

    this.keyHandler = (event) => {
      if (event.eventType === "release") return;
      if (event.name === "escape") {
        this.unmount();
        return;
      }
      this.current?.onKey(event);
    };
    (this.scene.renderer as unknown as {
      keyInput: { on: (event: string, cb: (e: ModalKeyEvent) => void) => void };
    }).keyInput.on("keypress", this.keyHandler);

    this.current = modal;
    modal.mount(this.container, {
      scene: this.scene,
      renderer: this.scene.renderer,
      dismiss: () => this.unmount(),
    });
  }

  unmount(): void {
    if (!this.current || !this.container) return;
    try {
      this.current.unmount();
    } catch {
      // ignore cleanup errors
    }
    try {
      this.scene.voidSurface.remove("modal-container");
    } catch {
      // already removed
    }
    try {
      this.container.destroy();
    } catch {
      // already destroyed
    }
    if (this.keyHandler) {
      (this.scene.renderer as unknown as {
        keyInput: { off: (event: string, cb: (e: ModalKeyEvent) => void) => void };
      }).keyInput.off("keypress", this.keyHandler);
      this.keyHandler = null;
    }
    this.current = null;
    this.container = null;

    this.ambient.setPaused(false);
    this.posts.setPaused(false);
    this.scene.showCompose();
  }
}
