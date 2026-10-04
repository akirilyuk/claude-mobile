import fs from 'node:fs';
import path from 'node:path';

// File DB inside the workspace:
//   .claude-mobile/sessions/<id>.json   session metadata
//   .claude-mobile/sessions/<id>.jsonl  append-only log of everything said in the session
export class Store {
  constructor(workspace) {
    this.root = path.join(workspace, '.claude-mobile');
    this.dir = path.join(this.root, 'sessions');
    fs.mkdirSync(this.dir, { recursive: true });
    const ignore = path.join(this.root, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  }

  loadAll() {
    const metas = [];
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        metas.push(JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')));
      } catch {
        // A half-written or corrupt meta file should not stop the others loading.
      }
    }
    return metas;
  }

  saveMeta(meta) {
    const file = path.join(this.dir, `${meta.id}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, file);
  }

  appendEvent(id, event) {
    fs.appendFileSync(path.join(this.dir, `${id}.jsonl`), JSON.stringify(event) + '\n');
  }

  readEvents(id) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(this.dir, `${id}.jsonl`), 'utf8');
    } catch {
      return [];
    }
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // Skip a torn last line left by a crash mid-append.
      }
    }
    return events;
  }

  remove(id) {
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    fs.rmSync(path.join(this.dir, `${id}.jsonl`), { force: true });
  }
}
