export interface LiveChatMessage {
  id?: string;
  sequence?: string | number;
  role?: string;
  [key: string]: any;
}

export interface LiveChatSnapshot {
  messages?: LiveChatMessage[];
  cursor?: string | null;
  [key: string]: any;
}

export interface LiveChatPage {
  messages: LiveChatMessage[];
  nextCursor: string | null;
  reset?: boolean;
  more?: boolean;
  completed?: boolean;
}

export interface LiveChatSource {
  load(force: boolean): Promise<LiveChatSnapshot>;
  page(cursor: string | null, limit: number): Promise<LiveChatPage>;
}

export interface LiveChatView {
  reset(messages: readonly LiveChatMessage[]): void;
  append(message: LiveChatMessage, index: number): void;
  setCompleted(completed: boolean): void;
  showError(error: unknown, hasMessages: boolean): void;
  dispose?(): void;
}

export interface LiveChatScheduler {
  set(callback: () => void, delay: number): unknown;
  clear(timer: unknown): void;
}

const defaultScheduler: LiveChatScheduler = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const messageKey = (message: LiveChatMessage) =>
  `${message.sequence}:${message.id}`;

export class LiveChatController {
  readonly messages: LiveChatMessage[] = [];
  cursor: string | null = null;
  private readonly known = new Set<string>();
  private failures = 0;
  private timer: unknown = null;
  private running = false;
  private generation = 0;

  constructor(
    private readonly source: LiveChatSource,
    private readonly view: LiveChatView,
    private readonly onSnapshot: (snapshot: LiveChatSnapshot) => void,
    private readonly scheduler: LiveChatScheduler = defaultScheduler,
  ) {}

  async load(force = false) {
    try {
      const snapshot = await this.source.load(force);
      this.replace(snapshot.messages || [], snapshot.cursor || null);
      this.view.reset(this.messages);
      this.onSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      this.view.showError(error, this.messages.length > 0);
      return null;
    }
  }

  render() {
    this.view.reset(this.messages);
  }

  start(delay = 0) {
    if (this.running) return;
    this.running = true;
    this.generation++;
    this.schedule(delay, this.generation);
  }

  stop() {
    this.running = false;
    this.generation++;
    if (this.timer !== null) this.scheduler.clear(this.timer);
    this.timer = null;
  }

  dispose() {
    this.stop();
    this.view.dispose?.();
  }

  async pollOnce() {
    const page = await this.source.page(this.cursor, 100);
    if (page.reset) await this.load(true);
    else {
      this.append(page.messages || []);
      this.cursor = page.nextCursor;
    }
    this.view.setCompleted(Boolean(page.completed));
    this.failures = 0;
    return page;
  }

  private replace(messages: LiveChatMessage[], cursor: string | null) {
    this.messages.splice(0, this.messages.length, ...messages);
    this.cursor = cursor;
    this.known.clear();
    for (const message of messages) this.known.add(messageKey(message));
  }

  private append(messages: LiveChatMessage[]) {
    for (const message of messages) {
      const key = messageKey(message);
      if (this.known.has(key)) continue;
      this.known.add(key);
      const index = this.messages.length;
      this.messages.push(message);
      this.view.append(message, index);
    }
  }

  private schedule(delay: number, generation: number) {
    if (!this.running || generation !== this.generation) return;
    if (this.timer !== null) this.scheduler.clear(this.timer);
    this.timer = this.scheduler.set(() => {
      this.timer = null;
      void this.pollAndSchedule(generation);
    }, delay);
  }

  private async pollAndSchedule(generation: number) {
    try {
      const page = await this.pollOnce();
      if (!this.running || generation !== this.generation) return;
      this.schedule(page.more ? 0 : page.completed ? 8_000 : 1_500, generation);
    } catch {
      if (!this.running || generation !== this.generation) return;
      this.failures++;
      this.schedule(Math.min(30_000, 1_000 * 2 ** this.failures), generation);
    }
  }
}

export interface LiveChatDomOptions {
  conversation: HTMLElement;
  timeline: HTMLElement;
  renderMessage(message: LiveChatMessage, index: number): string;
  renderTimeline(message: LiveChatMessage, index: number): string;
  hasTimeline(message: LiveChatMessage): boolean;
  bindTimeline(button: HTMLElement): void;
  setCompleted(completed: boolean): void;
  showError(error: unknown, hasMessages: boolean): void;
}

export function createLiveChatDomView(
  options: LiveChatDomOptions,
): LiveChatView {
  let observer: IntersectionObserver | null = null;

  const makeObserver = () => {
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) =>
              Math.abs(a.boundingClientRect.top) -
              Math.abs(b.boundingClientRect.top),
          )[0];
        if (!visible) return;
        options.timeline
          .querySelectorAll<HTMLElement>(".timelinedot")
          .forEach((element) =>
            element.classList.toggle(
              "active",
              element.dataset.index ===
                (visible.target as HTMLElement).dataset.index,
            ),
          );
      },
      {
        root: options.conversation,
        rootMargin: "-10% 0px -65% 0px",
        threshold: 0,
      },
    );
  };

  const bindButton = (index: number) => {
    const button = options.timeline.querySelector<HTMLElement>(
      `.timelinedot[data-index="${CSS.escape(String(index))}"]`,
    );
    if (button) options.bindTimeline(button);
  };

  return {
    reset(messages) {
      const activeElement = document.activeElement as HTMLElement | null;
      const focusedTimeline = activeElement?.classList.contains("timelinedot")
        ? activeElement.dataset.index
        : null;
      makeObserver();
      options.conversation.innerHTML =
        messages.map(options.renderMessage).join("") ||
        "<p>No messages found.</p>";
      options.timeline.innerHTML = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => options.hasTimeline(message))
        .map(({ message, index }) => options.renderTimeline(message, index))
        .join("");
      options.timeline
        .querySelectorAll<HTMLElement>(".timelinedot")
        .forEach(options.bindTimeline);
      if (focusedTimeline != null)
        requestAnimationFrame(() =>
          options.timeline
            .querySelector<HTMLElement>(
              `.timelinedot[data-index="${CSS.escape(focusedTimeline)}"]`,
            )
            ?.focus(),
        );
      options.conversation
        .querySelectorAll<HTMLElement>(".message.user")
        .forEach((element) => observer?.observe(element));
    },
    append(message, index) {
      if (index === 0) options.conversation.innerHTML = "";
      options.conversation.insertAdjacentHTML(
        "beforeend",
        options.renderMessage(message, index),
      );
      if (!options.hasTimeline(message)) return;
      options.timeline.insertAdjacentHTML(
        "beforeend",
        options.renderTimeline(message, index),
      );
      bindButton(index);
      const article = options.conversation.querySelector(
        `#session-message-${CSS.escape(String(index))}`,
      );
      if (article) observer?.observe(article);
    },
    setCompleted: options.setCompleted,
    showError: options.showError,
    dispose() {
      observer?.disconnect();
      observer = null;
    },
  };
}
