// Verifies a V1 backup produced by supabase/export_v1_backup.sql.
// Read-only and offline: it never contacts Supabase and never modifies the file.
//
//   node tools/verify_v1_backup.mjs <backup-file> <fingerprint>
//
// <backup-file> may be the copied `backup` value, or the whole export result
// saved from the SQL Editor as JSON or CSV. <fingerprint> is the `fingerprint`
// column of that same export. Exit code 0 means the file is complete and
// byte-for-byte consistent with the database at export time.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const md5 = text => createHash('md5').update(text,'utf8').digest('hex');
function fail(message) { console.error(`BACKUP NOT VERIFIED: ${message}`); process.exit(1); }

const [file, expected] = process.argv.slice(2);
if (!file || !/^[0-9a-f]{32}$/.test(expected || '')) fail('usage: node tools/verify_v1_backup.mjs <backup-file> <32-character fingerprint>');

// Minimal RFC 4180 reader for a SQL Editor CSV download.
function parseCSV(text) {
  const rows = [[]]; let field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i+1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { rows.at(-1).push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i+1] === '\n') i++;
      rows.at(-1).push(field); field = ''; rows.push([]);
    } else field += c;
  }
  rows.at(-1).push(field);
  if (quoted) throw new Error('unterminated quoted CSV field');
  return rows.filter(row => row.length > 1 || row[0] !== '');
}
function unwrap(value) {
  if (typeof value === 'string') value = JSON.parse(value);
  if (Array.isArray(value)) {
    if (value.length !== 1) fail(`expected exactly one exported result row, found ${value.length}`);
    value = value[0];
  }
  return value && value.format === undefined && value.backup !== undefined ? unwrap(value.backup) : value;
}

let backup;
try {
  const text = (await readFile(file,'utf8')).replace(/^﻿/,'').trim();
  if (text.startsWith('{') || text.startsWith('[')) backup = unwrap(JSON.parse(text));
  else {
    const rows = parseCSV(text), column = rows[0]?.indexOf('backup');
    if (column === undefined || column < 0 || rows.length !== 2) fail('CSV must contain a header row with a "backup" column and exactly one data row');
    backup = unwrap(rows[1][column]);
  }
} catch (error) {
  fail(`cannot read or parse ${file} (${error.message}). It may be truncated or not the exported result.`);
}
if (backup?.format !== 'autoresearch-v1-backup' || backup.version !== 1) fail('this is not an AutoResearch V1 backup document');

for (const table of ['profiles','ideas','idea_events']) {
  const rows = backup[table];
  if (!Array.isArray(rows)) fail(`the backup has no ${table} list`);
  if (rows.length !== Number(backup.counts?.[table])) fail(`${table}: ${rows.length} rows, but the export reported ${backup.counts?.[table]}`);
  for (const row of rows) {
    for (const [key,value] of Object.entries(row)) if (value !== null && typeof value !== 'string') fail(`${table}: field "${key}" is not in canonical text form`);
  }
  if (new Set(rows.map(row => row.id)).size !== rows.length) fail(`${table}: duplicate ids`);
}

// Completeness and attribution: every reference resolves inside the backup.
const profiles = new Map(backup.profiles.map(p => [p.id,p.display_name]));
for (const idea of backup.ideas) {
  if (!idea.title?.trim()) fail(`IDEA-${idea.idea_number} has no title`);
  if (typeof idea.description !== 'string') fail(`IDEA-${idea.idea_number} has no Markdown description`);
  for (const field of ['created_by','assigned_to']) {
    if (idea[field] && !profiles.has(idea[field])) fail(`IDEA-${idea.idea_number}: ${field} is not an exported profile`);
  }
}
for (const event of backup.idea_events) {
  if (event.actor_id && !profiles.has(event.actor_id)) fail(`event ${event.id}: actor is not an exported profile`);
  for (const field of ['previous_state','new_state']) {
    if (event[field] !== null) { try { JSON.parse(event[field]); } catch { fail(`event ${event.id}: ${field} is not valid JSON`); } }
  }
}

// Same canonical form as the export query and tracker_private.v1_fingerprint().
const line = row => Object.keys(row).sort().map(key => row[key] === null ? key : `${key}=${row[key]}`).join('\u001f');
const tableHash = (rows,order) => md5([...rows].sort(order).map(line).join('\n'));
const byId = (a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const byNumber = key => (a,b) => Number(a[key]) - Number(b[key]);
const fingerprint = md5(`autoresearch-v1-backup-1\nprofiles=${tableHash(backup.profiles,byId)}\nideas=${tableHash(backup.ideas,byNumber('idea_number'))}\nevents=${tableHash(backup.idea_events,byNumber('id'))}`);
if (fingerprint !== backup.fingerprint) fail('the content does not match the fingerprint stored in the file: it was altered or corrupted');
if (fingerprint !== expected) fail('the content does not match the fingerprint you supplied: wrong file, or the data changed between exports');

const first = backup.ideas.find(idea => idea.idea_number === '1');
if (!first) fail('IDEA-001 is missing from the backup');
console.log(`Backup verified: ${file}
  fingerprint   ${fingerprint} (matches)
  exported at   ${backup.exported_at}
  contents      ${backup.profiles.length} profiles · ${backup.ideas.length} ideas · ${backup.idea_events.length} activity events
  IDEA-001      "${first.title}" by ${profiles.get(first.created_by)} · ${Buffer.byteLength(first.description,'utf8')} bytes of Markdown · md5 ${md5(first.description)}
Compare the IDEA-001 values with the idea_001_* columns of the export result.`);
