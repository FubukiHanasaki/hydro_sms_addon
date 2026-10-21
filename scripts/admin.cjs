#!/usr/bin/env node
// Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later.
const fs = require('node:fs');
const { MongoClient } = require('mongodb');

async function main() {
  const [action, uidText, configPath] = process.argv.slice(2);
  const uid = Number(uidText);
  if (!['grant', 'revoke', 'list'].includes(action) || !configPath || (action !== 'list' && (!Number.isSafeInteger(uid) || uid <= 0))) {
    throw new Error('Usage: node scripts/admin.cjs <grant|revoke|list> <uid|0> /absolute/path/to/hydro/config.json');
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const uri = config.uri || config.url;
  if (!uri) throw new Error('Hydro config must contain uri or url. Credentials are never printed.');
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(config.name || undefined);
    const collection = db.collection('sms_policy');
    if (action === 'list') {
      const policy = await collection.findOne({ _id: 'global' });
      console.log(JSON.stringify({ admins: policy?.admins || [], revision: policy?.revision || 0 }, null, 2));
      return;
    }
    if (!await db.collection('user').findOne({ _id: uid }, { projection: { _id: 1 } })) throw new Error('Hydro UID does not exist.');
    const audit = await db.collection('sms_audit').insertOne({ uid: null, actor: 'server-cli', action: `admin.${action}`, target: String(uid), at: new Date(), outcome: 'pending' });
    let result;
    if (action === 'grant') {
      result = await collection.updateOne({ _id: 'global' }, { $addToSet: { admins: uid }, $setOnInsert: { grants: [] }, $inc: { revision: 1 } }, { upsert: true });
    } else {
      result = await collection.updateOne({ _id: 'global', admins: uid, $expr: { $gt: [{ $size: '$admins' }, 1] } }, { $pull: { admins: uid }, $inc: { revision: 1 } });
    }
    const success = !!(result.modifiedCount || result.upsertedCount);
    await db.collection('sms_audit').updateOne({ _id: audit.insertedId }, { $set: { outcome: success ? 'success' : 'unchanged', finishedAt: new Date() } });
    if (!success) throw new Error('No change. The last plugin administrator cannot be revoked.');
    console.log(`Plugin administrator ${action}: Hydro UID ${uid}`);
  } finally { await client.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
