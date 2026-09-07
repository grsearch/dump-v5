'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readConfig } = require('../src/config');
const { latestEnd, DAY, dayName, scrub, publicState, buildArchive } = require('../src/reporting/archive');
const { uploadVerified, makeClient } = require('../src/reporting/upload');
const { run, reportConfig } = require('../scripts/upload-daily');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { HELIUS_API_KEY: 'helius-test-secret', STATE_FILE: path.join(dir, 'paper.json'), SHADOW_DIRECTORY: path.join(dir, 'shadow'), COS_EXPORT_DIRECTORY: path.join(dir, 'exports') };
  fs.mkdirSync(env.SHADOW_DIRECTORY);
  return { dir, env, c: readConfig(env), end: Date.parse('2026-09-07T23:00:00Z') };
}
function write(file, rows) { fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); }
function unpack(file) { return zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').map(JSON.parse); }
function fakeCOS() {
  const objects = new Map(), calls = [];
  return { calls, objects,
    uploadFile(p, cb) { calls.push(p.Key); objects.set(p.Key, { bytes: fs.statSync(p.FilePath).size, hash: p.Headers['x-cos-meta-sha256'] }); cb(null, {}); },
    headObject(p, cb) { const o = objects.get(p.Key); cb(null, { headers: { 'content-length': String(o.bytes), 'x-cos-meta-sha256': o.hash, etag: 'fake' } }); } };
}
test('daily boundary is exactly Beijing 07:00 regardless of host timezone or US DST', () => {
  for (const date of ['2026-03-08', '2026-09-07', '2026-11-01']) {
    const end = Date.parse(`${date}T23:00:00Z`);
    assert.equal(latestEnd(end), end); assert.equal(latestEnd(end - 1), end - DAY);
    assert.equal(latestEnd(end + 86400000 - 1), end);
  }
  assert.equal(dayName(Date.parse('2026-09-07T23:00:00Z')), '2026-09-08');
});
test('archive includes all window records, linked pre-window samples, and reports partial data', async t => {
  const f = fixture(t), start = f.end - DAY;
  write(`${f.c.stateFile}.jsonl`, [
    { time: new Date(start - 5).toISOString(), type: 'paper_buy', positionId: 'trade1' },
    { time: new Date(start).toISOString(), type: 'paper_sell', positionId: 'trade1' },
    { time: new Date(f.end).toISOString(), type: 'outside' }]);
  const shadow = path.join(f.env.SHADOW_DIRECTORY, 'samples-test.jsonl');
  write(shadow, [{ type: 'session', at: start - 5000 }, { type: 'sample', id: 's1', at: start - 1 },
    { type: 'outcome', id: 's1', at: start + 5000, target: 'rebound_60s', label: 1 }]);
  fs.appendFileSync(shadow, '{broken}\n{"partial":');
  const a = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end });
  const rows = unpack(a.file);
  assert.equal(a.summary.stats.windowRecords, 2); assert.equal(a.summary.stats.invalidLines, 1); assert.equal(a.summary.stats.partialLines, 1);
  assert.equal(a.summary.dataQuality, 'needs_review');
  assert.ok(rows.some(r => r.context && r.record.type === 'sample'));
  assert.ok(rows.some(r => r.context && r.record.type === 'paper_buy'));
  assert.ok(!rows.some(r => r.record.type === 'outside'));
});
test('credentials, endpoints and pending signed bytes never enter archive', async t => {
  const f = fixture(t);
  write(`${f.c.stateFile}.jsonl`, [{ time: new Date(f.end - 1).toISOString(), type: 'error', error: 'oops TOPSECRET https://host/?api-key=abc', SecretId: 'id' }]);
  fs.writeFileSync(f.c.stateFile, JSON.stringify({ mode: 'paper', pending: { sig: { signature: 'sig', serialized: 'REPLAYABLE', swap: { secret: 'x' } } } }));
  const a = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end, secrets: ['TOPSECRET', f.env.HELIUS_API_KEY] });
  const text = zlib.gunzipSync(fs.readFileSync(a.file)).toString();
  for (const secret of ['TOPSECRET', 'REPLAYABLE', 'https://host', f.env.HELIUS_API_KEY]) assert.ok(!text.includes(secret));
  assert.deepEqual(publicState({ pending: { sig: { signature: 'sig', serialized: 'bad' } } }).pending.sig, { signature: 'sig' });
  assert.equal(scrub({ privateKey: 'a' }).privateKey, '[redacted]');
});
test('late-written records from the prior day are carried into the next archive', async t => {
  const f = fixture(t), file = `${f.c.stateFile}.jsonl`;
  write(file, [{ time: new Date(f.end - 10000).toISOString(), type: 'original' }]);
  const a = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end });
  fs.appendFileSync(file, JSON.stringify({ time: new Date(f.end - 1000).toISOString(), type: 'late_flush' }) + '\n');
  const b = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end + DAY, previousSources: a.summary.sources });
  const rows = unpack(b.file);
  assert.ok(rows.some(r => r.record.type === 'late_flush' && r.context));
  assert.ok(!rows.some(r => r.record.type === 'original'));
  fs.truncateSync(file, 0);
  const truncated = await buildArchive({ c: f.c, outputDir: f.env.COS_EXPORT_DIRECTORY, end: f.end + 2 * DAY, previousSources: b.summary.sources });
  assert.equal(truncated.summary.sourceChanges.length, 1);
  assert.equal(truncated.summary.dataQuality, 'needs_review');
});
test('upload verifies size and digest metadata and refuses mismatched remote object', async t => {
  const f = fixture(t), file = path.join(f.dir, 'test.json'); fs.writeFileSync(file, '{}');
  const client = fakeCOS(); const result = await uploadVerified(client, reportConfig(f.env), file, 'test/key');
  assert.equal(result.bytes, 2); assert.equal(result.sha256.length, 64);
  client.headObject = (_, cb) => cb(null, { headers: { 'content-length': '0' } });
  await assert.rejects(uploadVerified(client, reportConfig(f.env), file, 'test/key'), /verification/);
});
test('failed upload retains window and retries identical artifact before advancing; same day is no-op', async t => {
  const f = fixture(t), client = fakeCOS();
  const bad = { uploadFile: (_, cb) => cb(new Error('network')) };
  await assert.rejects(run({ env: f.env, now: f.end + 5000, client: bad }), /network/);
  const cursor = path.join(f.env.COS_EXPORT_DIRECTORY, 'upload-state.json');
  assert.equal(JSON.parse(fs.readFileSync(cursor)).nextEnd, f.end);
  const result = await run({ env: f.env, now: f.end + 10000, client });
  assert.equal(result.status, 'uploaded'); assert.equal(client.calls.length, 2);
  const again = await run({ env: f.env, now: f.end + 20000, client });
  assert.equal(again.status, 'up_to_date'); assert.equal(client.calls.length, 2);
  const recovered = await run({ env: f.env, now: f.end + 3 * DAY + 5000, client });
  assert.equal(recovered.uploaded.length, 3);
});
test('local-only export needs no COS credentials and never advances upload state', async t => {
  const f = fixture(t); const result = await run({ env: f.env, now: f.end + 1000, localOnly: true });
  assert.equal(result.status, 'local_export_only');
  assert.ok(!fs.existsSync(path.join(f.env.COS_EXPORT_DIRECTORY, 'upload-state.json')));
  assert.throws(() => makeClient({}), /credentials/);
  const sdk = makeClient({ COS_SECRET_ID: 'fake', COS_SECRET_KEY: 'fake' });
  assert.equal(sdk.options.Protocol, 'https:'); assert.equal(sdk.options.UploadCheckContentMd5, true);
});
test('destination changes and corrupt frozen archives cannot silently advance the cursor', async t => {
  const f = fixture(t), client = fakeCOS();
  await run({ env: f.env, now: f.end + 1000, localOnly: true });
  fs.appendFileSync(path.join(f.env.COS_EXPORT_DIRECTORY, dayName(f.end), 'analysis.jsonl.gz'), 'bad');
  await assert.rejects(run({ env: f.env, now: f.end + 1000, client }), /integrity/);
  await assert.rejects(run({ env: { ...f.env, COS_INSTANCE_ID: 'different' }, now: f.end + 1000, client }), /cursor/);
});
