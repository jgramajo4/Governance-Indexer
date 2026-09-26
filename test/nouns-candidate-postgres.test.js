const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { candidateTargetId } = require('../src/domain/nouns-candidate');
const { PostgresGovernanceStore, PostgresTransaction } = require('../src/postgres-store');

const TARGET_ID = candidateTargetId(`0x${'11'.repeat(20)}`, 'slug');
const BLOCK_HASH = `0x${'aa'.repeat(32)}`;
const CONTENT_HASH = `0x${'bb'.repeat(32)}`;

const target = {
  dao: 'nouns', targetId: TARGET_ID, kind: 'candidate', proposer: `0x${'11'.repeat(20)}`, slug: 'slug',
  title: 'Candidate title', description: '# Candidate title',
  nativeState: 'ACTIVE', eligibility: 'PRE_VOTE', mappingVersion: 'nouns-candidate-lifecycle/1',
  contentHash: CONTENT_HASH, actions: [], latestVersion: { id: 'v1', createdBlock: '200', createdTimestamp: '1', updateMessage: '' },
};

test('candidate migration persists non-numeric canonical targets with lifecycle constraints', () => {
  const sql = fs.readFileSync('migrations/004_nouns_candidates.sql', 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS governance_targets/);
  assert.match(sql, /target_id text/);
  assert.match(sql, /kind IN \('candidate'\)/);
  assert.match(sql, /eligibility IN \('PRE_VOTE','CLOSED'\)/);
  assert.match(sql, /title text NOT NULL/);
  assert.match(sql, /description text NOT NULL/);
  assert.doesNotMatch(sql, /proposal_id numeric/);
});

test('Postgres target persistence and projection bind normalized content to exact raw provenance', async () => {
  const calls = [];
  const tx = new PostgresTransaction({ async query(sql, values) { calls.push({ sql: String(sql), values }); return { rowCount: 1, rows: [] }; } });
  await tx.upsertTarget(target);
  assert.match(calls[0].sql, /INSERT INTO governance_targets/);
  assert.deepEqual(calls[0].values.slice(0, 4), ['nouns', TARGET_ID, 'candidate', target.proposer]);

  const pool = { async query(sql, values) {
    const text = String(sql);
    assert.match(text, /FROM governance_targets t/);
    assert.match(text, /r\.source_record_key=t\.target_id/);
    assert.match(text, /r\.content_hash=t\.content_hash/);
    assert.deepEqual(values, ['nouns', TARGET_ID]);
    return { rows: [{ ...target, refreshedAt: new Date('2026-09-18T00:00:00Z'), sourceBlock: '200', sourceBlockHash: BLOCK_HASH }] };
  } };
  assert.deepEqual(await new PostgresGovernanceStore({ pool }).getGateTarget('nouns', TARGET_ID), {
    ...target, refreshedAt: '2026-09-18T00:00:00.000Z', sourceBlock: '200', sourceBlockHash: BLOCK_HASH,
  });
});
