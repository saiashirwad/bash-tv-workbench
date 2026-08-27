import fsp from "node:fs/promises";
import path from "node:path";

const identityOf = (stat) =>
  `${stat.dev}:${stat.ino}:${Math.trunc(stat.birthtimeMs || stat.ctimeMs)}`;

/** Incremental reader for the newest Pi JSONL session.
 * The selected filename is cached. Normal reads stat that one file and only read
 * bytes appended since the previous request; the directory tree is revisited on
 * a bounded interval to notice a newly-created session.
 */
export class LiveSessionReader {
  constructor(
    root,
    { discoveryIntervalMs = 10_000, now = () => Date.now() } = {},
  ) {
    this.root = root;
    this.discoveryIntervalMs = discoveryIntervalMs;
    this.now = now;
    this.selected = null;
    this.lastDiscovery = 0;
    this.offset = 0;
    this.remainder = Buffer.alloc(0);
    this.rows = [];
    this.identity = null;
  }

  async discover() {
    const directories = await fsp
      .readdir(this.root, { withFileTypes: true })
      .catch(() => []);
    let latest = null;
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const parent = path.join(this.root, directory.name);
      for (const name of await fsp.readdir(parent).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(parent, name);
        const stat = await fsp.stat(file).catch(() => null);
        if (stat?.isFile() && (!latest || stat.mtimeMs > latest.stat.mtimeMs))
          latest = { file, stat };
      }
    }
    this.lastDiscovery = this.now();
    return latest;
  }

  reset(file, stat) {
    this.selected = file;
    this.identity = identityOf(stat);
    this.offset = 0;
    this.remainder = Buffer.alloc(0);
    this.rows = [];
  }

  async refresh() {
    let reset = false;
    let stat = this.selected
      ? await fsp.stat(this.selected).catch(() => null)
      : null;
    const discoveryDue =
      !this.selected ||
      this.now() - this.lastDiscovery >= this.discoveryIntervalMs;
    if (discoveryDue) {
      const latest = await this.discover();
      if (!latest) {
        if (this.selected) reset = true;
        this.reset(null, { dev: 0, ino: 0, birthtimeMs: 0 });
        this.identity = null;
        return { reset, rows: this.rows, identity: null, stat: null };
      }
      if (
        latest.file !== this.selected ||
        identityOf(latest.stat) !== this.identity
      ) {
        this.reset(latest.file, latest.stat);
        reset = true;
      }
      stat = latest.stat;
    }
    if (!this.selected || !stat)
      return { reset, rows: this.rows, identity: null, stat: null };
    if (identityOf(stat) !== this.identity || stat.size < this.offset) {
      this.reset(this.selected, stat);
      reset = true;
    }
    if (stat.size > this.offset) {
      const length = stat.size - this.offset;
      const handle = await fsp.open(this.selected, "r");
      const appended = Buffer.alloc(length);
      try {
        await handle.read(appended, 0, length, this.offset);
      } finally {
        await handle.close();
      }
      this.offset = stat.size;
      const bytes = Buffer.concat([this.remainder, appended]);
      let start = 0;
      for (let index = 0; index < bytes.length; index++) {
        if (bytes[index] !== 10) continue;
        const line = bytes.subarray(start, index).toString("utf8").trim();
        start = index + 1;
        if (!line) continue;
        try {
          this.rows.push(JSON.parse(line));
        } catch {
          /* tolerate malformed producer records */
        }
      }
      this.remainder = bytes.subarray(start);
    }
    return { reset, rows: this.rows, identity: this.identity, stat };
  }
}

export const parseLiveCursor = (cursor) => {
  const match = typeof cursor === "string" ? /^(.*):(\d+)$/.exec(cursor) : null;
  return match ? { identity: match[1], sequence: Number(match[2]) } : null;
};

export const liveCursor = (identity, sequence) =>
  identity ? `${identity}:${sequence}` : null;

export const paginateLiveMessages = (identity, messages, cursor, limit) => {
  const parsed = parseLiveCursor(cursor);
  const reset =
    cursor != null &&
    (!parsed ||
      parsed.identity !== identity ||
      parsed.sequence > messages.length);
  const after = reset ? 0 : parsed?.sequence || 0;
  const page = messages.slice(after, after + limit);
  const nextSequence = page.length ? page[page.length - 1].sequence : after;
  return {
    messages: page,
    nextCursor: liveCursor(identity, nextSequence),
    reset,
    more: nextSequence < messages.length,
  };
};
