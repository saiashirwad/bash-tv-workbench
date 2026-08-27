// frontend/live-chat.ts
var defaultScheduler = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer)
};
var messageKey = (message) => `${message.sequence}:${message.id}`;
var LiveChatController = class {
  constructor(source, view, onSnapshot, scheduler = defaultScheduler) {
    this.source = source;
    this.view = view;
    this.onSnapshot = onSnapshot;
    this.scheduler = scheduler;
  }
  source;
  view;
  onSnapshot;
  scheduler;
  messages = [];
  cursor = null;
  known = /* @__PURE__ */ new Set();
  failures = 0;
  timer = null;
  running = false;
  generation = 0;
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
  replace(messages, cursor) {
    this.messages.splice(0, this.messages.length, ...messages);
    this.cursor = cursor;
    this.known.clear();
    for (const message of messages) this.known.add(messageKey(message));
  }
  append(messages) {
    for (const message of messages) {
      const key = messageKey(message);
      if (this.known.has(key)) continue;
      this.known.add(key);
      const index = this.messages.length;
      this.messages.push(message);
      this.view.append(message, index);
    }
  }
  schedule(delay, generation) {
    if (!this.running || generation !== this.generation) return;
    if (this.timer !== null) this.scheduler.clear(this.timer);
    this.timer = this.scheduler.set(() => {
      this.timer = null;
      void this.pollAndSchedule(generation);
    }, delay);
  }
  async pollAndSchedule(generation) {
    try {
      const page = await this.pollOnce();
      if (!this.running || generation !== this.generation) return;
      this.schedule(page.more ? 0 : page.completed ? 8e3 : 1500, generation);
    } catch {
      if (!this.running || generation !== this.generation) return;
      this.failures++;
      this.schedule(Math.min(3e4, 1e3 * 2 ** this.failures), generation);
    }
  }
};
function createLiveChatDomView(options) {
  let observer = null;
  const makeObserver = () => {
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort(
          (a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top)
        )[0];
        if (!visible) return;
        options.timeline.querySelectorAll(".timelinedot").forEach(
          (element) => element.classList.toggle(
            "active",
            element.dataset.index === visible.target.dataset.index
          )
        );
      },
      {
        root: options.conversation,
        rootMargin: "-10% 0px -65% 0px",
        threshold: 0
      }
    );
  };
  const bindButton = (index) => {
    const button = options.timeline.querySelector(
      `.timelinedot[data-index="${CSS.escape(String(index))}"]`
    );
    if (button) options.bindTimeline(button);
  };
  return {
    reset(messages) {
      const activeElement = document.activeElement;
      const focusedTimeline = activeElement?.classList.contains("timelinedot") ? activeElement.dataset.index : null;
      makeObserver();
      options.conversation.innerHTML = messages.map(options.renderMessage).join("") || "<p>No messages found.</p>";
      options.timeline.innerHTML = messages.map((message, index) => ({ message, index })).filter(({ message }) => options.hasTimeline(message)).map(({ message, index }) => options.renderTimeline(message, index)).join("");
      options.timeline.querySelectorAll(".timelinedot").forEach(options.bindTimeline);
      if (focusedTimeline != null)
        requestAnimationFrame(
          () => options.timeline.querySelector(
            `.timelinedot[data-index="${CSS.escape(focusedTimeline)}"]`
          )?.focus()
        );
      options.conversation.querySelectorAll(".message.user").forEach((element) => observer?.observe(element));
    },
    append(message, index) {
      if (index === 0) options.conversation.innerHTML = "";
      options.conversation.insertAdjacentHTML(
        "beforeend",
        options.renderMessage(message, index)
      );
      if (!options.hasTimeline(message)) return;
      options.timeline.insertAdjacentHTML(
        "beforeend",
        options.renderTimeline(message, index)
      );
      bindButton(index);
      const article = options.conversation.querySelector(
        `#session-message-${CSS.escape(String(index))}`
      );
      if (article) observer?.observe(article);
    },
    setCompleted: options.setCompleted,
    showError: options.showError,
    dispose() {
      observer?.disconnect();
      observer = null;
    }
  };
}
export {
  LiveChatController,
  createLiveChatDomView
};
