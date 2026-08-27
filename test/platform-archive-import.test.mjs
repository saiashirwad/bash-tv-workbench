import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeWorkbenchPlatform } from "../workbench-platform.mjs";

const PYTHON_FIXTURE = String.raw`
import io, json, stat, struct, sys, tarfile, zipfile
kind, target, spec = sys.argv[1], sys.argv[2], json.load(sys.stdin)
if kind == 'zip':
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for item in spec:
            info = zipfile.ZipInfo(item['name']); info.compress_type = zipfile.ZIP_DEFLATED
            if item['type'] == 'symlink':
                info.create_system = 3; info.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(info, item['target'])
            else:
                if item.get('mode') == 'device': info.create_system = 3; info.external_attr = (stat.S_IFCHR | 0o600) << 16
                archive.writestr(info, item.get('content', '') or ('0' * item.get('contentSize', 0)))
    declared = [item.get('declaredSize') for item in spec]
    if any(size is not None for size in declared):
        data = bytearray(open(target, 'rb').read()); local = central = 0
        for size in declared:
            local = data.index(b'PK\x03\x04', local); central = data.index(b'PK\x01\x02', central)
            if size is not None:
                struct.pack_into('<II', data, local + 18, size, size); struct.pack_into('<II', data, central + 20, size, size)
            local += 4; central += 4
        open(target, 'wb').write(data)
else:
    with tarfile.open(target, 'w:gz') as archive:
        for item in spec:
            info = tarfile.TarInfo(item['name']); kind = item['type']
            if kind == 'file':
                data = (item.get('content', '') or ('0' * item.get('contentSize', 0))).encode(); info.size = len(data); archive.addfile(info, io.BytesIO(data))
            elif kind == 'symlink': info.type = tarfile.SYMTYPE; info.linkname = item['target']; archive.addfile(info)
            elif kind == 'hardlink': info.type = tarfile.LNKTYPE; info.linkname = item['target']; archive.addfile(info)
            elif kind == 'fifo': info.type = tarfile.FIFOTYPE; archive.addfile(info)
            elif kind == 'socket': info.type = b's'; archive.addfile(info)
`;

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-archive-"));
  const projectRoot = path.join(root, "project"); const stateRoot = path.join(root, "state");
  await fsp.mkdir(projectRoot); await fsp.writeFile(path.join(projectRoot, "existing.txt"), "old");
  const platform = makeWorkbenchPlatform({ projects: new Map([["test", { id: "test", root: projectRoot }]]), stateRoot });
  t.after(async () => { await platform.shutdown(); await fsp.rm(root, { recursive: true, force: true }); });
  return { platform, projectRoot, stateRoot, root };
}

async function archive(stateRoot, format, spec) {
  const artifactRoot = path.join(stateRoot, "artifacts-v1"); await fsp.mkdir(artifactRoot, { recursive: true });
  const id = crypto.randomUUID(); const target = path.join(artifactRoot, `${id}-fixture.${format}`);
  const result = spawnSync("python3", ["-c", PYTHON_FIXTURE, format === "zip" ? "zip" : "tar", target], { input: JSON.stringify(spec), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const bytes = await fsp.readFile(target); const metadata = { id, project: "test", fileName: path.basename(target), path: target, format, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await fsp.writeFile(`${target}.json`, JSON.stringify(metadata)); return id;
}

for (const format of ["zip", "tar.gz"]) {
  test(`${format} import validates in staging, reports conflicts, and imports valid files`, async (t) => {
    const { platform, projectRoot, stateRoot } = await fixture(t);
    const artifactId = await archive(stateRoot, format, [
      { type: "file", name: "existing.txt", content: "new" },
      { type: "file", name: "nested/new.txt", content: "safe" },
    ]);
    const dryRun = await platform.importArchive({ project: "test", artifactId });
    assert.deepEqual(dryRun.conflicts, ["existing.txt"]); assert.equal(dryRun.dryRun, true);
    assert.equal(await fsp.readFile(path.join(projectRoot, "existing.txt"), "utf8"), "old");
    await assert.rejects(platform.importArchive({ project: "test", artifactId, dryRun: false }), (cause) => cause._tag === "ImportConflict");
    await assert.rejects(platform.importArchive({ project: "test", artifactId, dryRun: false, overwrite: true }), (cause) => cause._tag === "ConfirmationRequired");
    const imported = await platform.importArchive({ project: "test", artifactId, dryRun: false, overwrite: true, confirm: true });
    assert.equal(imported.entries, 2); assert.equal(await fsp.readFile(path.join(projectRoot, "existing.txt"), "utf8"), "new");
    assert.equal(await fsp.readFile(path.join(projectRoot, "nested/new.txt"), "utf8"), "safe");
  });
}

test("ZIP import rejects traversal, absolute paths, symlink escapes, and suspicious ratios", async (t) => {
  const { platform, stateRoot, root } = await fixture(t);
  for (const spec of [
    [{ type: "file", name: "../escaped.txt", content: "bad" }],
    [{ type: "file", name: "/absolute.txt", content: "bad" }],
    [{ type: "symlink", name: "link", target: "../../outside" }],
    [{ type: "file", name: "device", content: "", mode: "device" }],
    [{ type: "file", name: "bomb.txt", contentSize: 16 * 1024 * 1024 }],
    [{ type: "file", name: "huge.txt", declaredSize: 300 * 1024 * 1024 }],
    Array.from({ length: 5 }, (_, index) => ({ type: "file", name: `total-${index}`, declaredSize: 250 * 1024 * 1024 })),
  ]) {
    const artifactId = await archive(stateRoot, "zip", spec);
    await assert.rejects(platform.importArchive({ project: "test", artifactId }), (cause) => cause._tag === "ImportFailed");
  }
  await assert.rejects(fsp.access(path.join(root, "escaped.txt")));
});

test("tar.gz import rejects traversal, escaping links, hardlink escapes, and special files", async (t) => {
  const { platform, stateRoot, root } = await fixture(t);
  for (const spec of [
    [{ type: "file", name: "../../escaped.txt", content: "bad" }],
    [{ type: "file", name: "/absolute.txt", content: "bad" }],
    [{ type: "symlink", name: "link", target: "../../outside" }],
    [{ type: "hardlink", name: "hard", target: "../../outside" }],
    [{ type: "fifo", name: "pipe" }],
    [{ type: "socket", name: "socket" }],
  ]) {
    const artifactId = await archive(stateRoot, "tar.gz", spec);
    await assert.rejects(platform.importArchive({ project: "test", artifactId }), (cause) => cause._tag === "ImportFailed");
  }
  await assert.rejects(fsp.access(path.join(root, "escaped.txt")));
});

test("archive import rejects excessive entry counts", async (t) => {
  const { platform, stateRoot } = await fixture(t);
  const spec = Array.from({ length: 5_001 }, (_, index) => ({ type: "file", name: `files/${index}`, content: "" }));
  const artifactId = await archive(stateRoot, "zip", spec);
  await assert.rejects(platform.importArchive({ project: "test", artifactId }), /excessive file count/);
});
