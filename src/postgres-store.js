const fs = require("node:fs/promises");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { Pool } = require("pg");
const {
  eventKey,
  decodeCursor,
  encodeCursor,
  decodeProposalCursor,
  encodeProposalCursor,
} = require("./memory-store");
const { sanitizeConfig, sanitizeEndpoint, sanitizeProvenance } = require("./provenance");
const { PROVISIONED_ROLES, auditRoles, ensureRoles, presentRoles, verifyPermissions } = require("./roles");

const { TrackingState, trackingStateFor, presentProposal } = require("./domain/lifecycle");
const { redactErrorMessage } = require("./redaction");
const { canonicalGateActions } = require("./gate-action");
const { canonicalCandidateTarget } = require("./candidate-target");
const { DAO_CONFIGS } = require("./config");
const { proposalContentHash } = require("./domain/nouns-history");

// A WARM proposal (succeeded, queued) can still change, but not on the cadence a
// live vote does. Re-reading it once a quarter hour is enough and keeps a steady
// cycle proportional to open governance rather than to post-vote backlog.
const DEFAULT_WARM_REFRESH_MS = 15 * 60 * 1000;

function proposalCursor(value) {
  if (!value) return null;
  return typeof value === "string" && /^\d+$/.test(value) ? value : decodeProposalCursor(value);
}

function rawRow(record) {
  const raw = record.raw;
  return sanitizeProvenance({
    ...raw,
    proposalId: raw.proposalId || record.proposal?.proposalId || record.vote?.proposalId || null,
    contentHash: raw.contentHash || record.proposal?.contentHash || null,
  });
}

function canonicalMaterial(row) {
  return {
    blockNumber: String(row.blockNumber),
    blockHash: row.blockHash || null,
    recordType: row.recordType,
    proposalId: row.proposalId == null ? null : String(row.proposalId),
    contentHash: row.contentHash || null,
    payload: row.payload,
  };
}

function immutableEventMaterial(row) {
  const material = canonicalMaterial(row);
  delete material.blockNumber;
  delete material.blockHash;
  return material;
}

function endpointOrigin(value) {
  try { return new URL(value).origin; } catch { return "https://source.invalid"; }
}

class PostgresTransaction {
  constructor(client) { this.client = client; }

  async upsertDao(row) {
    const safeRow = sanitizeConfig(row);
    await this.client.query(`
      INSERT INTO daos(id,name,chain_id,governance_type,current_governor,contract_address,from_block,config,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,chain_id=excluded.chain_id,governance_type=excluded.governance_type,
        current_governor=excluded.current_governor,contract_address=excluded.contract_address,
        from_block=excluded.from_block,config=excluded.config,updated_at=now()
    `, [
      safeRow.id, safeRow.name || safeRow.id, safeRow.chainId, safeRow.governanceType || "onchain",
      safeRow.currentGovernor || safeRow.contractAddress || null, safeRow.contractAddress || null,
      safeRow.fromBlock ?? 1, safeRow,
    ]);
  }

  async upsertSource(row) {
    const safeRow = sanitizeProvenance(row);
    await this.client.query(`
      INSERT INTO governance_sources(dao_id,id,kind,endpoint,from_block,config)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(dao_id,id) DO UPDATE SET
        kind=excluded.kind,endpoint=excluded.endpoint,from_block=excluded.from_block,
        config=excluded.config || (governance_sources.config - 'rpcCutoverBlock') ||
          CASE WHEN governance_sources.config ? 'rpcCutoverBlock'
            THEN jsonb_build_object('rpcCutoverBlock',governance_sources.config->'rpcCutoverBlock')
            ELSE '{}'::jsonb END
    `, [safeRow.daoId, safeRow.id, safeRow.kind, safeRow.endpoint, safeRow.fromBlock, safeRow]);
  }

  async setCheckpoint(row) {
    const lastError = row.lastError == null ? null : redactErrorMessage(row.lastError);
    await this.client.query(`
      INSERT INTO sync_checkpoints(dao_id,source_id,next_block,finalized_head,updated_at,last_full_scan_at,last_error)
      VALUES($1,$2,$3,$4,now(),$5,$6)
      ON CONFLICT(dao_id,source_id) DO UPDATE SET
        next_block=GREATEST(sync_checkpoints.next_block,excluded.next_block),
        finalized_head=GREATEST(sync_checkpoints.finalized_head,excluded.finalized_head),
        updated_at=now(),
        last_full_scan_at=COALESCE(excluded.last_full_scan_at,sync_checkpoints.last_full_scan_at),
        last_error=excluded.last_error
    `, [row.daoId, row.sourceId, row.nextBlock, row.finalizedHead, row.lastFullScanAt || null, lastError]);
  }

  async freezeRpcCutoverBlock(daoId, sourceId, fromBlock) {
    if (daoId !== "nouns" || sourceId !== "nouns-subgraph"
        || !Number.isSafeInteger(Number(fromBlock)) || Number(fromBlock) < 0) {
      throw new TypeError("invalid Nouns RPC cutover boundary");
    }
    await this.client.query(`
      UPDATE governance_sources
      SET config=jsonb_set(config,'{rpcCutoverBlock}',to_jsonb($3::bigint),true)
      WHERE dao_id=$1 AND id=$2 AND NOT (config ? 'rpcCutoverBlock')
    `, [daoId, sourceId, fromBlock]);
  }

  async setCandidateSnapshot({ daoId, sourceId, checkpointBlock, checkpointHash, snapshot }) {
    if (!Number.isSafeInteger(checkpointBlock) || checkpointBlock < 0
        || typeof checkpointHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(checkpointHash)
        || snapshot?.snapshot !== checkpointBlock || snapshot?.blockHash !== checkpointHash) {
      throw new TypeError("candidate snapshot checkpoint provenance is invalid");
    }
    await this.client.query(`
      INSERT INTO candidate_snapshots(dao_id,source_id,checkpoint_block,checkpoint_hash,snapshot)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(dao_id,source_id) DO UPDATE SET
        checkpoint_block=excluded.checkpoint_block,checkpoint_hash=excluded.checkpoint_hash,
        snapshot=excluded.snapshot,updated_at=now()
      WHERE candidate_snapshots.checkpoint_block<=excluded.checkpoint_block
    `, [daoId, sourceId, checkpointBlock, checkpointHash, JSON.stringify(snapshot)]);
  }

  async refreshMaterializedProposal({ daoId, sourceId, proposalId, contentHash, snapshot, payload }) {
    if (daoId !== "nouns" || sourceId !== "nouns-subgraph"
        || !/^(0|[1-9][0-9]*)$/.test(String(proposalId))
        || !/^[0-9a-fA-F]{64}$/.test(contentHash || "")
        || !/^0x[0-9a-fA-F]{64}$/.test(snapshot?.blockHash || "")
        || !Number.isSafeInteger(snapshot.blockNumber) || snapshot.blockNumber < 0
        || !payload || typeof payload !== "object" || Array.isArray(payload)
        || String(payload.id) !== String(proposalId) || typeof payload.description !== "string"
        || !["targets", "values", "signatures", "calldatas"].every((key) => Array.isArray(payload[key]))
        || !["values", "signatures", "calldatas"].every((key) => payload[key].length === payload.targets.length)
        || proposalContentHash(payload) !== contentHash) {
      throw new TypeError("invalid materialized Nouns proposal provenance");
    }
    // Lock the original evidence, but never relabel it. Refresh evidence lives
    // separately, keyed by canonical proposal identity and chain snapshot.
    const selected = await this.client.query(`
      SELECT block_number,observed_head,block_hash,content_hash
      FROM raw_governance_records
      WHERE dao_id=$1 AND source_id=$2 AND source_record_key='proposal:' || $3
        AND record_type='proposal' AND proposal_id::text=$3
      FOR UPDATE
    `, [daoId, sourceId, String(proposalId)]);
    const row = selected.rows[0];
    if (!row || BigInt(row.block_number) > BigInt(snapshot.blockNumber)
        || BigInt(row.observed_head) > BigInt(snapshot.blockNumber)
        || (BigInt(row.block_number) === BigInt(snapshot.blockNumber)
          && row.block_hash === snapshot.blockHash && row.content_hash !== contentHash)) {
      throw new Error(`materialized Nouns proposal provenance is stale or missing for ${proposalId}`);
    }
    const previous = (await this.client.query(`
      SELECT block_number,block_hash,content_hash,payload FROM nouns_proposal_refreshes
      WHERE dao_id=$1 AND source_id=$2 AND proposal_id=$3 FOR UPDATE
    `, [daoId, sourceId, proposalId])).rows[0];
    if (previous && (BigInt(previous.block_number) > BigInt(snapshot.blockNumber)
      || (BigInt(previous.block_number) === BigInt(snapshot.blockNumber)
        && previous.block_hash === snapshot.blockHash
        && (previous.content_hash !== contentHash || !isDeepStrictEqual(previous.payload, payload))))) {
      throw new Error(`materialized Nouns proposal provenance is stale or conflicting for ${proposalId}`);
    }
    await this.client.query(`
      INSERT INTO nouns_proposal_refreshes(dao_id,source_id,proposal_id,block_number,block_hash,content_hash,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(dao_id,source_id,proposal_id) DO UPDATE SET
        block_number=excluded.block_number,block_hash=excluded.block_hash,
        content_hash=excluded.content_hash,payload=excluded.payload,ingested_at=now()
    `, [daoId, sourceId, proposalId, snapshot.blockNumber, snapshot.blockHash, contentHash, payload]);
  }

  async upsertProposal(row) {
    const normalized = row.normalized;
    // `proposal_status` stays the raw upstream value. `effective_status` is what
    // Gavel derived, and `tracking_state` is what the refresh planner reads --
    // never the raw value, which upstream may leave stale forever.
    const effectiveStatus = normalized?.effectiveStatus || normalized?.outcome || "UNKNOWN";
    const trackingState = normalized?.trackingState || trackingStateFor(effectiveStatus);
    await this.client.query(`
      INSERT INTO proposals(
        dao_id,proposal_id,content_hash,title,description,proposer,proposal_status,outcome,
        created_block,start_block,end_block,quorum_votes,for_votes,against_votes,abstain_votes,
        normalized,first_seen_block,effective_status,tracking_state,lifecycle_reason,last_observed_block
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$9,$17,$18,$19,$20)
      ON CONFLICT(dao_id,proposal_id) DO UPDATE SET
        content_hash=excluded.content_hash,title=excluded.title,description=excluded.description,
        proposer=excluded.proposer,proposal_status=excluded.proposal_status,outcome=excluded.outcome,
        created_block=excluded.created_block,start_block=excluded.start_block,end_block=excluded.end_block,
        quorum_votes=excluded.quorum_votes,for_votes=excluded.for_votes,
        against_votes=excluded.against_votes,abstain_votes=excluded.abstain_votes,
        normalized=excluded.normalized,
        effective_status=excluded.effective_status,tracking_state=excluded.tracking_state,
        lifecycle_reason=excluded.lifecycle_reason,
        last_observed_block=GREATEST(COALESCE(proposals.last_observed_block,0),COALESCE(excluded.last_observed_block,0)),
        first_seen_block=LEAST(proposals.first_seen_block,excluded.first_seen_block),updated_at=now()
    `, [
      row.daoId, row.proposalId, row.contentHash, normalized?.title || "",
      normalized?.description || "", normalized?.proposer || null,
      normalized?.state || "UNKNOWN", normalized?.outcome || "UNKNOWN",
      normalized?.createdBlock ?? null, normalized?.startBlock ?? null, normalized?.endBlock ?? null,
      normalized?.quorumVotes ?? null, normalized?.forVotes ?? null,
      normalized?.againstVotes ?? null, normalized?.abstainVotes ?? null, normalized,
      effectiveStatus, trackingState, normalized?.lifecycleReason || null, row.lastObservedBlock ?? null,
    ]);
    if (row.actions !== undefined) {
      const actions = canonicalGateActions(row.actions, { indexKey: "index" });
      await this.client.query("DELETE FROM proposal_actions WHERE dao_id=$1 AND proposal_id=$2", [row.daoId, row.proposalId]);
      for (const canonical of actions) {
        await this.client.query(`
          INSERT INTO proposal_actions(dao_id,proposal_id,action_index,target,value_wei,signature,calldata)
          VALUES($1,$2,$3,$4,$5,$6,$7)
        `, [row.daoId, row.proposalId, canonical.actionIndex, canonical.target, canonical.valueWei, canonical.signature, canonical.calldata]);
      }
    }
  }

  async upsertTarget(row) {
    row = canonicalCandidateTarget(row);
    await this.client.query(`
      INSERT INTO governance_targets(dao_id,target_id,kind,proposer,slug,title,description,native_state,eligibility,mapping_version,content_hash,actions,latest_version,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
      ON CONFLICT(dao_id,target_id) DO UPDATE SET
        proposer=excluded.proposer,slug=excluded.slug,title=excluded.title,description=excluded.description,
        native_state=excluded.native_state,eligibility=excluded.eligibility,
        mapping_version=excluded.mapping_version,content_hash=excluded.content_hash,actions=excluded.actions,
        latest_version=excluded.latest_version,updated_at=now()
    `, [row.dao, row.targetId, row.kind, row.proposer, row.slug, row.title, row.description,
      row.nativeState, row.eligibility, row.mappingVersion, String(row.contentHash).replace(/^0x/, ""),
      JSON.stringify(row.actions), JSON.stringify(row.latestVersion)]);
  }

  async insertVote(row) {
    const safeRow = sanitizeProvenance(row);
    const result = await this.client.query(`
      INSERT INTO vote_events(
        dao_id,source_id,source_record_key,chain_id,contract_address,proposal_id,voter,support,reason,vote_weight,
        block_number,block_time,transaction_hash,log_index,source_kind,source_endpoint,source_public_endpoint,observed_head,normalized
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT(chain_id,contract_address,transaction_hash,log_index) DO UPDATE SET
        normalized=COALESCE(excluded.normalized,vote_events.normalized),
        observed_head=GREATEST(vote_events.observed_head,excluded.observed_head)
    `, [
      safeRow.daoId, safeRow.sourceId || null, safeRow.sourceRecordKey || null, safeRow.chainId, safeRow.contractAddress,
      safeRow.proposalId, safeRow.voter, safeRow.support, safeRow.reason, safeRow.voteWeight, safeRow.blockNumber, safeRow.timestamp,
      safeRow.transactionHash, safeRow.logIndex, safeRow.sourceKind, safeRow.sourceEndpoint,
      safeRow.sourceEndpoint, safeRow.observedHead, safeRow.normalized || null,
    ]);
    return result.rowCount > 0;
  }

  async insertDelegation(row) {
    const safeRow = sanitizeProvenance(row);
    const result = await this.client.query(`
      INSERT INTO delegation_events(
        dao_id,chain_id,contract_address,delegator,delegatee,block_number,block_time,
        transaction_hash,log_index,source_kind,source_endpoint,normalized
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(chain_id,contract_address,transaction_hash,log_index) DO NOTHING
    `, [
      safeRow.daoId, safeRow.chainId, safeRow.contractAddress, safeRow.delegator, safeRow.delegatee,
      safeRow.blockNumber, safeRow.timestamp, safeRow.transactionHash, safeRow.logIndex,
      safeRow.sourceKind, safeRow.sourceEndpoint, safeRow.normalized || null,
    ]);
    return result.rowCount > 0;
  }

  async ingest(record) {
    const raw = rawRow(record);
    let result;
    if (raw.recordType === "proposal_candidate" && raw.sourceRecordKey) {
      await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${raw.daoId}:${raw.sourceId}:${raw.sourceRecordKey}`,
      ]);
      const existing = (await this.client.query(`
        SELECT block_number AS "blockNumber",observed_head AS "observedHead",block_hash AS "blockHash",
          record_type AS "recordType",proposal_id::text AS "proposalId",content_hash AS "contentHash",payload
        FROM raw_governance_records WHERE dao_id=$1 AND source_id=$2 AND source_record_key=$3
      `, [raw.daoId, raw.sourceId, raw.sourceRecordKey])).rows[0];
      if (existing) {
        if (String(existing.blockNumber) === String(raw.blockNumber)
            && (existing.blockHash || null) === (raw.blockHash || null)
            && !isDeepStrictEqual(immutableEventMaterial(existing), immutableEventMaterial(raw))) {
          throw new Error(`canonical candidate drift for ${eventKey(raw)}`);
        }
        const refreshed = await this.client.query(`
          UPDATE raw_governance_records SET block_number=$4,block_hash=$5,observed_head=$6,
            content_hash=$7,payload=$8,transaction_hash=$9,log_index=$10,ingested_at=now()
          WHERE dao_id=$1 AND source_id=$2 AND source_record_key=$3
            AND block_number<=$4 AND observed_head<=$6
        `, [raw.daoId, raw.sourceId, raw.sourceRecordKey, raw.blockNumber, raw.blockHash, raw.observedHead,
          raw.contentHash, raw.payload, raw.transactionHash, raw.logIndex]);
        if (refreshed.rowCount === 0) return false;
        result = { rowCount: 0 };
      }
    }
    if (raw.recordType === "proposal" && raw.sourceRecordKey) {
      // Serialize the first insert as well as refreshes for this canonical key.
      // The lock is transaction-scoped, so normalized state can only be written
      // by the snapshot that won the corresponding raw provenance decision.
      await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${raw.daoId}:${raw.sourceId}:${raw.sourceRecordKey}`,
      ]);
      const existing = (await this.client.query(`
        SELECT block_number AS "blockNumber",observed_head AS "observedHead",block_hash AS "blockHash",record_type AS "recordType",
          proposal_id::text AS "proposalId",content_hash AS "contentHash",payload,
          external_id AS "externalId",chain_id AS "chainId",contract_address AS "contractAddress",source_kind AS "sourceKind"
        FROM raw_governance_records WHERE dao_id=$1 AND source_id=$2 AND source_record_key=$3
      `, [raw.daoId, raw.sourceId, raw.sourceRecordKey])).rows[0];
      if (existing) {
        const rpcRefresh = raw.daoId === "nouns" && raw.sourceId === "nouns-subgraph"
          && (raw.sourceKind === "nouns-governor-logs" || raw.sourceKind === "nouns-rpc")
          && /^0x[0-9a-fA-F]{64}$/.test(raw.blockHash || "")
          && record.proposal?.contentHash === raw.contentHash;
        const changed = !isDeepStrictEqual(immutableEventMaterial(existing), immutableEventMaterial(raw));
        if (!rpcRefresh && !changed) {
          const refreshed = await this.client.query(`
            UPDATE raw_governance_records
            SET block_number=$4,block_hash=$5,observed_head=$6,ingested_at=now()
            WHERE dao_id=$1 AND source_id=$2 AND source_record_key=$3
              AND block_number<=$4 AND observed_head<=$6
          `, [raw.daoId, raw.sourceId, raw.sourceRecordKey, raw.blockNumber, raw.blockHash, raw.observedHead]);
          if (refreshed.rowCount === 0) return false;
          result = { rowCount: 0 };
        } else {
        const cutover = raw.daoId === "nouns" && raw.sourceId === "nouns-subgraph"
          ? (await this.client.query("SELECT config->>'rpcCutoverBlock' AS block FROM governance_sources WHERE dao_id=$1 AND id=$2", [raw.daoId, raw.sourceId])).rows[0]?.block
          : null;
        const historical = existing.sourceKind === 'nouns-subgraph'
          || (cutover != null && BigInt(existing.blockNumber) < BigInt(cutover));
        if ((existing.proposalId != null && existing.proposalId !== raw.proposalId)
            || (existing.externalId != null && existing.externalId !== raw.externalId)
            || (existing.chainId != null && Number(existing.chainId) !== Number(raw.chainId))
            || (existing.contractAddress != null
              && String(existing.contractAddress).toLowerCase() !== String(raw.contractAddress).toLowerCase())) {
          throw new Error(`canonical proposal identity drift for ${eventKey(raw)}`);
        }
        if (BigInt(raw.blockNumber) < BigInt(existing.blockNumber)
            || BigInt(raw.observedHead) < BigInt(existing.observedHead)) return false;
        if (historical && rpcRefresh) {
          // A materialized refresh carries no raw payload. A purported new raw
          // event for a pre-cutover key cannot replace its original evidence.
          if (changed) throw new Error(`canonical event drift for ${eventKey(raw)}`);
          return false;
        }
        if (historical && existing.contentHash === raw.contentHash && existing.blockHash === raw.blockHash) {
          if (record.proposal) await this.upsertProposal(record.proposal);
          return false;
        }
        // The same canonical block cannot change content. A different hash at
        // the same height is a reorg; higher snapshots can carry RPC updates.
        if (changed && (!rpcRefresh || (String(existing.blockNumber) === String(raw.blockNumber)
          && existing.blockHash === raw.blockHash))) {
          throw new Error(`canonical event drift for ${eventKey(raw)}`);
        }
        const refreshed = await this.client.query(`
          UPDATE raw_governance_records
          SET block_number=$4,block_hash=$5,observed_head=$6,content_hash=$7,
            payload=$8,ingested_at=now()
          WHERE dao_id=$1 AND source_id=$2 AND source_record_key=$3
            AND block_number<=$4 AND observed_head<=$6
            AND (block_number<$4 OR block_hash IS DISTINCT FROM $5 OR observed_head<$6)
        `, [raw.daoId, raw.sourceId, raw.sourceRecordKey, raw.blockNumber, raw.blockHash, raw.observedHead,
          raw.contentHash, raw.payload]);
        if (refreshed.rowCount === 0) {
          // No provenance change is needed for a repeat at the same block.
          if (String(existing.blockNumber) !== String(raw.blockNumber)
              || existing.blockHash !== raw.blockHash || existing.contentHash !== raw.contentHash) return false;
        }
        result = { rowCount: 0 };
        }
      }
    }
    if (!result) result = await this.client.query(`
      INSERT INTO raw_governance_records(
        dao_id,source_id,source_record_key,external_id,chain_id,contract_address,transaction_hash,log_index,
        block_number,block_hash,record_type,proposal_id,content_hash,payload,source_kind,
        source_endpoint,observed_head
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT DO NOTHING
    `, [
      raw.daoId, raw.sourceId, raw.sourceRecordKey || null, raw.externalId || null, raw.chainId, raw.contractAddress,
      raw.transactionHash, raw.logIndex, raw.blockNumber, raw.blockHash, raw.recordType,
      raw.proposalId, raw.contentHash, raw.payload, raw.sourceKind, raw.sourceEndpoint, raw.observedHead,
    ]);
    // Normalized rows are reconciled even when the immutable raw source record
    // was already indexed, so a vote dropped by an earlier partial write is
    // repaired by re-running the sync instead of being lost permanently.
    if (record.proposal) await this.upsertProposal(record.proposal);
    if (record.target) await this.upsertTarget(record.target);
    if (record.vote) await this.insertVote(record.vote);
    if (record.delegation) await this.insertDelegation(record.delegation);
    return result.rowCount > 0;
  }

  async reconcileRange({ daoId, sourceId, fromBlock, toBlock, records, cutoverBlock = null }) {
    const incoming = new Map(records.map((record) => {
      const row = rawRow(record);
      return [eventKey(row), row];
    }));
    const selected = await this.client.query(`
      SELECT dao_id AS "daoId",source_id AS "sourceId",source_record_key AS "sourceRecordKey",
        chain_id AS "chainId",contract_address AS "contractAddress",
        transaction_hash AS "transactionHash",log_index AS "logIndex",
        block_number AS "blockNumber",block_hash AS "blockHash",record_type AS "recordType",
        proposal_id::text AS "proposalId",content_hash AS "contentHash",payload
      FROM raw_governance_records
      WHERE dao_id=$1 AND source_id=$2 AND block_number BETWEEN $3 AND $4
        AND ($5::bigint IS NULL OR block_number >= $5)
        AND NOT (record_type='proposal' AND source_record_key IS NOT NULL)
    `, [daoId, sourceId, fromBlock, toBlock, cutoverBlock]);
    const existingByKey = new Map(selected.rows.map((row) => [eventKey(row), row]));

    const chainRows = [...incoming.values()].filter((row) => !row.sourceRecordKey);
    if (chainRows.length) {
      const values = [];
      const tuples = [];
      for (const row of chainRows) {
        const offset = values.length + 1;
        values.push(row.chainId, String(row.contractAddress).toLowerCase(), String(row.transactionHash).toLowerCase(), row.logIndex);
        tuples.push(`($${offset},$${offset + 1},$${offset + 2},$${offset + 3})`);
      }
      const identities = await this.client.query(`
        SELECT dao_id AS "daoId",source_id AS "sourceId",source_record_key AS "sourceRecordKey",
          chain_id AS "chainId",contract_address AS "contractAddress",
          transaction_hash AS "transactionHash",log_index AS "logIndex",
          block_number AS "blockNumber",block_hash AS "blockHash",record_type AS "recordType",
          proposal_id::text AS "proposalId",content_hash AS "contentHash",payload
        FROM raw_governance_records
        WHERE (chain_id,lower(contract_address),lower(transaction_hash),log_index) IN (${tuples.join(",")})
      `, values);
      for (const row of identities.rows) existingByKey.set(eventKey(row), row);
    }
    const sourceRows = [...incoming.values()].filter((row) => row.sourceRecordKey);
    if (sourceRows.length) {
      const values = [];
      const tuples = [];
      for (const row of sourceRows) {
        const offset = values.length + 1;
        values.push(row.daoId, row.sourceId, row.sourceRecordKey);
        tuples.push(`($${offset},$${offset + 1},$${offset + 2})`);
      }
      const identities = await this.client.query(`
        SELECT dao_id AS "daoId",source_id AS "sourceId",source_record_key AS "sourceRecordKey",
          chain_id AS "chainId",contract_address AS "contractAddress",
          transaction_hash AS "transactionHash",log_index AS "logIndex",
          block_number AS "blockNumber",block_hash AS "blockHash",record_type AS "recordType",
          proposal_id::text AS "proposalId",content_hash AS "contentHash",payload
        FROM raw_governance_records
        WHERE (dao_id,source_id,source_record_key) IN (${tuples.join(",")})
      `, values);
      for (const row of identities.rows) existingByKey.set(eventKey(row), row);
    }

    for (const [key, next] of incoming) {
      const existing = existingByKey.get(key);
      if (existing && (cutoverBlock == null || BigInt(existing.blockNumber) >= BigInt(cutoverBlock))
          && !isDeepStrictEqual(immutableEventMaterial(existing), immutableEventMaterial(next))) {
        throw new Error(`canonical event drift for ${key}`);
      }
    }

    const removals = new Map(selected.rows.filter((row) => !incoming.has(eventKey(row))).map((row) => [eventKey(row), row]));
    for (const [key, next] of incoming) {
      const existing = existingByKey.get(key);
      if (existing && (cutoverBlock == null || BigInt(existing.blockNumber) >= BigInt(cutoverBlock))
          && (String(existing.blockNumber) !== String(next.blockNumber) || (existing.blockHash || null) !== (next.blockHash || null))) removals.set(key, existing);
    }
    const removedProposalIds = new Set();
    for (const row of removals.values()) {
      if (row.sourceRecordKey) {
        const identity = [row.daoId, row.sourceId, row.sourceRecordKey];
        await this.client.query("DELETE FROM vote_events WHERE dao_id=$1 AND source_id=$2 AND source_record_key=$3", identity);
        await this.client.query("DELETE FROM raw_governance_records WHERE dao_id=$1 AND source_id=$2 AND source_record_key=$3", identity);
      } else {
        const identity = [row.chainId, row.contractAddress, row.transactionHash, row.logIndex];
        await this.client.query(`
          DELETE FROM vote_events
          WHERE chain_id=$1 AND contract_address=$2 AND transaction_hash=$3 AND log_index=$4
        `, identity);
        await this.client.query(`
          DELETE FROM delegation_events
          WHERE chain_id=$1 AND contract_address=$2 AND transaction_hash=$3 AND log_index=$4
        `, identity);
        await this.client.query(`
          DELETE FROM raw_governance_records
          WHERE chain_id=$1 AND contract_address=$2 AND transaction_hash=$3 AND log_index=$4
        `, identity);
      }
      if (row.recordType === "proposal" && row.proposalId) removedProposalIds.add(String(row.proposalId));
    }
    for (const proposalId of removedProposalIds) {
      await this.client.query(`
        DELETE FROM proposals p
        WHERE p.dao_id=$1 AND p.proposal_id=$2
          AND NOT EXISTS (
            SELECT 1 FROM raw_governance_records r
            WHERE r.dao_id=p.dao_id AND r.record_type='proposal' AND r.proposal_id=p.proposal_id
          )
      `, [daoId, proposalId]);
    }
  }

  async reconcileRpcProposals({ daoId, sourceId, fromBlock, toBlock, cutoverBlock, createdIds }) {
    if (daoId !== 'nouns' || sourceId !== 'nouns-subgraph'
        || ![fromBlock, toBlock].every((n) => Number.isSafeInteger(n) && n >= 0)
        || fromBlock > toBlock || (cutoverBlock != null && (!Number.isSafeInteger(cutoverBlock) || cutoverBlock < 0))
        || !Array.isArray(createdIds) || !createdIds.every((id) => /^(0|[1-9][0-9]*)$/.test(String(id)))) {
      throw new TypeError('invalid RPC proposal reconciliation range');
    }
    const present = new Set(createdIds.map(String));
    const rows = (await this.client.query(`
      SELECT id,proposal_id::text AS "proposalId",
        payload->>'createdBlock' AS "createdBlock"
      FROM raw_governance_records
      WHERE dao_id=$1 AND source_id=$2 AND record_type='proposal'
        AND source_record_key='proposal:' || proposal_id::text
        AND source_kind IN ('nouns-governor-logs','nouns-rpc')
      FOR UPDATE
    `, [daoId, sourceId])).rows;
    for (const row of rows) {
      if (row.createdBlock == null || !/^(0|[1-9][0-9]*)$/.test(row.createdBlock)) continue;
      const created = BigInt(row.createdBlock);
      if (created < BigInt(fromBlock) || created > BigInt(toBlock)
          || created < BigInt(cutoverBlock ?? fromBlock) || present.has(row.proposalId)) continue;
      await this.client.query('DELETE FROM raw_governance_records WHERE id=$1', [row.id]);
      await this.client.query(`
        DELETE FROM nouns_proposal_refreshes n WHERE n.dao_id=$1 AND n.source_id=$2 AND n.proposal_id=$3
          AND NOT EXISTS (SELECT 1 FROM raw_governance_records r
            WHERE r.dao_id=n.dao_id AND r.source_id=n.source_id AND r.proposal_id=n.proposal_id AND r.record_type='proposal')
      `, [daoId, sourceId, row.proposalId]);
      await this.client.query(`
        DELETE FROM proposals p WHERE p.dao_id=$1 AND p.proposal_id=$2
          AND NOT EXISTS (SELECT 1 FROM raw_governance_records r
            WHERE r.dao_id=p.dao_id AND r.record_type='proposal' AND r.proposal_id=p.proposal_id)
      `, [daoId, row.proposalId]);
    }
  }

  async reconcileProposals({ daoId, sourceId, records, cutoverBlock = null }) {
    const incoming = new Map(records.map((record) => { const row = rawRow(record); return [eventKey(row), row]; }));
    const selected = await this.client.query(`
      SELECT dao_id AS "daoId",source_id AS "sourceId",source_record_key AS "sourceRecordKey",
        chain_id AS "chainId",contract_address AS "contractAddress",transaction_hash AS "transactionHash",
        log_index AS "logIndex",block_number AS "blockNumber",block_hash AS "blockHash",
        record_type AS "recordType",proposal_id::text AS "proposalId",content_hash AS "contentHash",payload,
        source_kind AS "sourceKind"
      FROM raw_governance_records
      WHERE dao_id=$1 AND source_id=$2 AND record_type='proposal' AND source_record_key IS NOT NULL
    `, [daoId, sourceId]);
    for (const row of selected.rows) {
      const next = incoming.get(eventKey(row));
      if (next && (cutoverBlock == null || (BigInt(row.blockNumber) >= BigInt(cutoverBlock)
          && row.sourceKind !== "nouns-subgraph"))
          && !(daoId === "nouns" && sourceId === "nouns-subgraph"
            && ["nouns-rpc", "nouns-governor-logs"].includes(next.sourceKind))
          && !isDeepStrictEqual(immutableEventMaterial(row), immutableEventMaterial(next))) throw new Error(`canonical event drift for ${eventKey(row)}`);
    }
    for (const row of selected.rows.filter((candidate) => !incoming.has(eventKey(candidate))
        && (cutoverBlock == null || (BigInt(candidate.blockNumber) >= BigInt(cutoverBlock)
          && candidate.sourceKind !== "nouns-subgraph")))) {
      await this.client.query("DELETE FROM raw_governance_records WHERE dao_id=$1 AND source_id=$2 AND source_record_key=$3", [daoId, sourceId, row.sourceRecordKey]);
      await this.client.query(`
        DELETE FROM proposals p WHERE p.dao_id=$1 AND p.proposal_id=$2
          AND NOT EXISTS (SELECT 1 FROM raw_governance_records r WHERE r.dao_id=p.dao_id AND r.record_type='proposal' AND r.proposal_id=p.proposal_id)
      `, [daoId, row.proposalId]);
    }
  }

  async reconcileCandidates({ daoId, sourceId, records }) {
    const incoming = new Set(records.map((record) => {
      canonicalCandidateTarget(record.target);
      return eventKey(rawRow(record));
    }));
    const selected = await this.client.query(`
      SELECT dao_id AS "daoId",source_id AS "sourceId",source_record_key AS "sourceRecordKey",
        chain_id AS "chainId",contract_address AS "contractAddress",transaction_hash AS "transactionHash",
        log_index AS "logIndex",block_number AS "blockNumber",record_type AS "recordType"
      FROM raw_governance_records
      WHERE dao_id=$1 AND source_id=$2 AND record_type='proposal_candidate' AND source_record_key IS NOT NULL
    `, [daoId, sourceId]);
    for (const row of selected.rows) if (!incoming.has(eventKey(row))) {
      await this.client.query("DELETE FROM raw_governance_records WHERE dao_id=$1 AND source_id=$2 AND source_record_key=$3", [daoId, sourceId, row.sourceRecordKey]);
      await this.client.query("DELETE FROM governance_targets WHERE dao_id=$1 AND target_id=$2", [daoId, row.sourceRecordKey]);
    }
  }
}

class PostgresGovernanceStore {
  constructor(options = {}) {
    this.votingPowerReader = options.votingPowerReader;
    if (options.pool) {
      this.pool = options.pool;
      return;
    }
    const maxConnections = Number(options.maxConnections || 10);
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 2) throw new RangeError("maxConnections must be an integer of at least 2 for advisory source locking");
    const poolOptions = {
      max: maxConnections,
      ssl: options.ssl,
    };
    const connectionString = options.connectionString || process.env.DATABASE_URL;
    if (connectionString) poolOptions.connectionString = connectionString;
    this.pool = new Pool(poolOptions);
  }

  async close() { await this.pool.end(); }

  // Applies the schema, reconciles the application roles, and reports the
  // role/grant state it actually observed. `roles: "granted"` is only ever
  // returned after the grants have been verified against the live database.
  async migrate(options = {}) {
    const dir = path.join(__dirname, "..", "migrations");
    await this.pool.query(await fs.readFile(path.join(dir, "001_initial.sql"), "utf8"));
    await this.pool.query(await fs.readFile(path.join(dir, "003_proposal_lifecycle.sql"), "utf8"));
    await this.pool.query(await fs.readFile(path.join(dir, "004_nouns_candidates.sql"), "utf8"));
    await this.pool.query(await fs.readFile(path.join(dir, "005_nouns_rpc_cutover.sql"), "utf8"));
    await this.pool.query(await fs.readFile(path.join(dir, "006_nouns_candidate_cache.sql"), "utf8"));
    await this.pool.query(await fs.readFile(path.join(dir, "007_nouns_proposal_refresh.sql"), "utf8"));
    const versions = ["001_initial", "003_proposal_lifecycle", "004_nouns_candidates", "005_nouns_rpc_cutover", "006_nouns_candidate_cache", "007_nouns_proposal_refresh"];

    // Role creation is idempotent and privilege-aware: on a fresh volume the
    // entrypoint script has already made the roles, on a reused volume this is
    // what creates them without destroying data.
    const ensured = options.ensureRoles === false
      ? { state: "present", created: [], missing: [] }
      : await ensureRoles(this.pool, { ...options, roles: PROVISIONED_ROLES });
    const roles = await presentRoles(this.pool, PROVISIONED_ROLES);
    const missingRoles = PROVISIONED_ROLES.filter((role) => !roles.includes(role));

    if (missingRoles.length || ensured.state === "skipped") {
      // Never fail silently: an ungranted API role is a deployment fault, not a
      // detail. `verify-permissions` is the gate that must pass before serving.
      return {
        ok: true,
        version: versions.at(-1),
        versions,
        roles: "skipped",
        rolesCreated: ensured.created,
        missingRoles,
        reason: ensured.reason || "the roles do not exist",
        warning: `Role grants were skipped because ${missingRoles.join(" and ")} do not exist. Create them (\`gavel-indexer ensure-roles\`, or docker/init-db.sh on a fresh volume) and re-run migrate, then run \`gavel-indexer verify-permissions --role gavel_api\`.`,
      };
    }

    await this.pool.query(await fs.readFile(path.join(dir, "002_roles.sql"), "utf8"));
    // Roles must exist before their grants can be applied. Report versions in
    // migration-number order even though 002 executes after schema setup.
    versions.splice(1, 0, "002_roles");

    // Governance Indexer migrations are the only schema owned and applied here.
    // Gate has its own database/migration lifecycle and is intentionally outside
    // this repository.
    // The grants ran without error, which is not the same as the roles now
    // being correct. Prove it by exercising them.
    const audit = await auditRoles(this.pool);
    if (!audit.ok) {
      return {
        ok: false,
        version: versions.at(-1),
        versions,
        roles: "invalid",
        rolesCreated: ensured.created,
        verified: audit.summary,
        violations: audit.violations,
        warning: "Role grants were applied but the resulting privileges are wrong. Do not serve traffic until `gavel-indexer verify-permissions --role gavel_api` passes.",
      };
    }
    return {
      ok: true,
      version: versions.at(-1),
      versions,
      roles: "granted",
      rolesCreated: ensured.created,
      verified: audit.summary,
    };
  }

  // Creates any missing application role without touching indexed data, so a
  // redeploy onto an existing PostgreSQL volume does not require wiping it.
  async ensureRoles(options = {}) {
    return ensureRoles(this.pool, { ...options, roles: PROVISIONED_ROLES });
  }

  // Which provisioned runtime roles the database currently has.
  async rolesStatus() {
    const present = await presentRoles(this.pool);
    return { present, missing: PROVISIONED_ROLES.filter((role) => !present.includes(role)) };
  }

  // Proves what the role can and cannot do by acting as it, rather than by
  // trusting the role's name or reading its GRANT statements back.
  async verifyPermissions(role = "gavel_api", options = {}) {
    return verifyPermissions(this.pool, role, options);
  }

  async transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(new PostgresTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async withSourceLock(daoId, sourceId, callback) {
    const client = await this.pool.connect();
    const key = `${daoId}:${sourceId}`;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
      return await callback();
    } finally {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]); }
      finally { client.release(); }
    }
  }

  async getCheckpoint(daoId, sourceId) {
    const result = await this.pool.query(`
      SELECT dao_id AS "daoId",source_id AS "sourceId",next_block::text AS "nextBlock",
        finalized_head::text AS "finalizedHead",updated_at AS "updatedAt",
        last_full_scan_at AS "lastFullScanAt",last_error AS "lastError"
      FROM sync_checkpoints WHERE dao_id=$1 AND source_id=$2
    `, [daoId, sourceId]);
    return result.rows[0] || null;
  }

  async getCandidateSnapshot(daoId, sourceId) {
    const result = await this.pool.query(`
      SELECT checkpoint_block::text AS "checkpointBlock",checkpoint_hash AS "checkpointHash",snapshot
      FROM candidate_snapshots WHERE dao_id=$1 AND source_id=$2
    `, [daoId, sourceId]);
    const row = result.rows[0];
    return row ? { ...row, checkpointBlock: Number(row.checkpointBlock) } : null;
  }

  async getRpcCutoverBlock(daoId, sourceId) {
    if (daoId !== "nouns" || sourceId !== "nouns-subgraph") return null;
    const row = (await this.pool.query("SELECT config->>'rpcCutoverBlock' AS block FROM governance_sources WHERE dao_id=$1 AND id=$2", [daoId, sourceId])).rows[0];
    return row?.block == null ? null : Number(row.block);
  }

  // Feeds incremental proposal enumeration: the highest indexed proposal id and
  // the proposals whose state can still change.
  async getProposalSyncContext(daoId, options = {}) {
    const max = (await this.pool.query(
      "SELECT max(proposal_id)::text AS \"maxProposalId\" FROM proposals WHERE dao_id=$1", [daoId],
    )).rows[0]?.maxProposalId ?? null;
    const warmAfterMs = Number(options.warmRefreshIntervalMs ?? DEFAULT_WARM_REFRESH_MS);
    // Everything still worth observing: every HOT proposal, plus WARM ones that
    // have gone unrefreshed long enough. FINAL rows are not selected at all, so
    // steady-state cost tracks open governance instead of DAO history.
    const refreshProposals = (await this.pool.query(`
      SELECT proposal_id::text AS "proposalId",content_hash AS "contentHash",normalized,
        tracking_state AS "trackingState",effective_status AS "effectiveStatus",
        last_observed_block::text AS "lastObservedBlock",updated_at AS "updatedAt"
      FROM proposals
      WHERE dao_id=$1 AND tracking_state <> $2
        AND (tracking_state = $3 OR updated_at <= now() - make_interval(secs => $4))
      ORDER BY proposal_id
    `, [daoId, TrackingState.FINAL, TrackingState.HOT, Math.max(0, warmAfterMs) / 1000])).rows;
    return { maxProposalId: max, refreshProposals };
  }

  // Lifecycle census for `gavel-indexer status`: how much of the index is still
  // being observed, and how much has been proven done.
  async trackingCounts() {
    return (await this.pool.query(`
      SELECT dao_id AS "daoId",tracking_state AS "trackingState",count(*)::int AS count
      FROM proposals GROUP BY dao_id,tracking_state ORDER BY dao_id,tracking_state
    `)).rows;
  }

  async listDaos() {
    return (await this.pool.query(`
      SELECT id,name,chain_id::text AS "chainId",governance_type AS "governanceType",
        current_governor AS "currentGovernor",contract_address AS "contractAddress",
        from_block::text AS "fromBlock",updated_at AS "updatedAt"
      FROM daos ORDER BY id
    `)).rows;
  }

  async getDao(id) {
    return (await this.pool.query(`
      SELECT id,name,chain_id::text AS "chainId",governance_type AS "governanceType",
        current_governor AS "currentGovernor",contract_address AS "contractAddress",
        from_block::text AS "fromBlock",updated_at AS "updatedAt"
      FROM daos WHERE id=$1
    `, [id])).rows[0] || null;
  }

  async getHealth(daoId) {
    if (typeof daoId !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(daoId)) throw new TypeError("invalid DAO id");
    const row = (await this.pool.query(`
      SELECT count(s.id) > 0 AND count(c.source_id) = count(s.id)
          AND bool_and(c.last_error IS NULL) AS healthy,
        min(c.updated_at) AS "refreshedAt",
        CASE WHEN bool_or(c.last_error IS NOT NULL) THEN 'sync_failed' ELSE NULL END AS "lastError"
      FROM governance_sources s
      LEFT JOIN sync_checkpoints c ON c.dao_id=s.dao_id AND c.source_id=s.id
      WHERE s.dao_id=$1
    `, [daoId])).rows[0];
    return {
      healthy: row?.healthy === true,
      refreshedAt: row?.refreshedAt instanceof Date ? row.refreshedAt.toISOString() : row?.refreshedAt ?? null,
      lastError: row?.lastError ?? null,
    };
  }

  async getVotingPower(daoId, wallet, options = {}) {
    if (daoId !== "nouns") throw new TypeError("voting power is only available for nouns");
    if (typeof wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new TypeError("invalid wallet");
    if (typeof this.votingPowerReader !== "function") throw new Error("canonical voting power reader is not configured");
    return this.votingPowerReader({ dao: daoId, wallet: wallet.toLowerCase() }, options);
  }

  async getGateProposal(daoId, id) {
    const row = (await this.pool.query(`
      SELECT p.proposal_id::text AS "proposalId",p.normalized->>'title' AS title,
        p.normalized->>'proposer' AS proposer,p.effective_status AS "effectiveStatus",
        p.lifecycle_reason AS "lifecycleReason",p.normalized AS normalized,
        provenance.ingested_at AS "refreshedAt",provenance.block_number::text AS "sourceBlock",
        provenance.block_hash AS "sourceBlockHash",'0x' || p.content_hash AS "contentHash",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'actionIndex',a.action_index,'target',a.target,'valueWei',a.value_wei::text,'signature',a.signature,'calldata',a.calldata
          ) ORDER BY a.action_index)
          FROM proposal_actions a WHERE a.dao_id=p.dao_id AND a.proposal_id=p.proposal_id
        ),'[]'::jsonb) AS actions
      FROM proposals p
      JOIN LATERAL (
        SELECT evidence.block_number,evidence.block_hash,evidence.ingested_at FROM (
          SELECT r.block_number,r.block_hash,r.ingested_at FROM raw_governance_records r
          WHERE r.dao_id=p.dao_id AND r.proposal_id=p.proposal_id
            AND r.source_id='nouns-subgraph' AND r.source_record_key='proposal:' || p.proposal_id::text
            AND r.record_type='proposal' AND r.content_hash=p.content_hash AND r.block_hash IS NOT NULL
          UNION ALL
          SELECT n.block_number,n.block_hash,n.ingested_at FROM nouns_proposal_refreshes n
          WHERE n.dao_id=p.dao_id AND n.source_id='nouns-subgraph' AND n.proposal_id=p.proposal_id
            AND n.content_hash=p.content_hash AND n.payload->>'description'=p.normalized->>'description'
        ) evidence ORDER BY evidence.block_number DESC,evidence.ingested_at DESC LIMIT 1
      ) provenance ON true
      WHERE p.dao_id=$1 AND p.proposal_id=$2
    `, [daoId, id])).rows[0];
    if (!row) return null;
    return {
      chainId: DAO_CONFIGS[daoId].chainId,
      governorAddress: DAO_CONFIGS[daoId].currentGovernor,
      proposalId: row.proposalId,
      title: row.title,
      proposer: row.proposer,
      refreshedAt: row.refreshedAt instanceof Date ? row.refreshedAt.toISOString() : row.refreshedAt,
      sourceBlock: row.sourceBlock,
      sourceBlockHash: row.sourceBlockHash,
      effectiveStatus: presentProposal(row.normalized, row).effectiveStatus,
      contentHash: typeof row.contentHash === "string" && row.contentHash.startsWith("0x") ? row.contentHash : `0x${row.contentHash}`,
      actions: row.actions,
    };
  }

  async getGateTarget(daoId, targetId) {
    if (String(targetId).startsWith("proposal:")) {
      const proposal = await this.getGateProposal(daoId, String(targetId).slice(9));
      return proposal ? { targetId, kind: "proposal", ...proposal } : null;
    }
    const row = (await this.pool.query(`
      SELECT t.dao_id AS dao,t.target_id AS "targetId",t.kind,t.proposer,t.slug,t.title,t.description,
        t.native_state AS "nativeState",
        t.eligibility,t.mapping_version AS "mappingVersion",'0x' || t.content_hash AS "contentHash",
        t.actions,t.latest_version AS "latestVersion",provenance.ingested_at AS "refreshedAt",
        provenance.block_number::text AS "sourceBlock",provenance.block_hash AS "sourceBlockHash"
      FROM governance_targets t
      JOIN LATERAL (
        SELECT r.block_number,r.block_hash,r.ingested_at FROM raw_governance_records r
        WHERE r.dao_id=t.dao_id AND r.source_id='nouns-subgraph' AND r.source_record_key=t.target_id
          AND r.record_type='proposal_candidate' AND r.content_hash=t.content_hash AND r.block_hash IS NOT NULL
        ORDER BY r.block_number DESC,r.id DESC LIMIT 1
      ) provenance ON true
      WHERE t.dao_id=$1 AND t.target_id=$2
    `, [daoId, targetId])).rows[0];
    if (!row) return null;
    return { ...row, refreshedAt: row.refreshedAt instanceof Date ? row.refreshedAt.toISOString() : row.refreshedAt };
  }

  async getProposal(daoId, id) {
    const row = (await this.pool.query(`
      SELECT p.dao_id AS dao,p.proposal_id::text AS "proposalId",p.normalized,
        p.proposal_status AS "proposalStatus",p.outcome,
        p.effective_status AS "effectiveStatus",p.tracking_state AS "trackingState",
        p.lifecycle_reason AS "lifecycleReason",
        provenance.ingested_at AS "refreshedAt",provenance.block_number::text AS "sourceBlock",
        provenance.block_hash AS "sourceBlockHash",'0x' || p.content_hash AS "contentHash",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'actionIndex',a.action_index,'target',a.target,'valueWei',a.value_wei::text,'signature',a.signature,'calldata',a.calldata
          ) ORDER BY a.action_index)
          FROM proposal_actions a WHERE a.dao_id=p.dao_id AND a.proposal_id=p.proposal_id
        ),'[]'::jsonb) AS actions
      FROM proposals p
      LEFT JOIN LATERAL (
        SELECT r.observed_head AS block_number,r.block_hash,r.ingested_at FROM raw_governance_records r
        WHERE r.dao_id=p.dao_id AND r.proposal_id=p.proposal_id
          AND r.record_type='proposal' AND r.content_hash=p.content_hash AND r.block_hash IS NOT NULL
        ORDER BY r.observed_head DESC,r.id DESC LIMIT 1
      ) provenance ON true
      WHERE p.dao_id=$1 AND p.proposal_id=$2
    `, [daoId, id])).rows[0];
    if (!row) return null;
    const contentHash = typeof row.contentHash === "string" && row.contentHash.startsWith("0x")
      ? row.contentHash : `0x${row.contentHash}`;
    const effectiveStatus = presentProposal(row.normalized, row).effectiveStatus;
    return {
      ...row,
      effectiveStatus,
      nativeState: effectiveStatus,
      sourceState: row.normalized?.sourceState ?? row.normalized?.state,
      refreshedAt: row.refreshedAt instanceof Date ? row.refreshedAt.toISOString() : row.refreshedAt,
      contentHash,
    };
  }

  async listProposals({ daoId, limit, cursor }) {
    const decoded = proposalCursor(cursor);
    const params = [daoId, limit + 1];
    let where = "dao_id=$1";
    if (decoded) {
      params.push(decoded);
      where += " AND proposal_id < $3";
    }
    const rows = (await this.pool.query(`
      SELECT dao_id AS "daoId",proposal_id::text AS "proposalId",normalized,
        proposal_status AS "proposalStatus",outcome,
        effective_status AS "effectiveStatus",tracking_state AS "trackingState",
        lifecycle_reason AS "lifecycleReason"
      FROM proposals WHERE ${where} ORDER BY proposal_id DESC LIMIT $2
    `, params)).rows;
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => ({
      ...presentProposal(row.normalized, row), daoId: row.daoId, proposalId: row.proposalId,
    }));
    return { items, nextCursor: more ? encodeProposalCursor(rows[limit - 1].proposalId) : null };
  }

  async listVotes({ daoId, voter, limit, cursor }) {
    const decoded = typeof cursor === "string" ? decodeCursor(cursor) : cursor;
    const params = [daoId, limit + 1];
    let where = "dao_id=$1";
    if (voter) {
      params.push(voter.toLowerCase());
      where += ` AND lower(voter)=$${params.length}`;
    }
    if (decoded) {
      const offset = params.length + 1;
      params.push(decoded.blockNumber, String(decoded.transactionHash).toLowerCase(), decoded.logIndex);
      where += ` AND (block_number,lower(transaction_hash),log_index)>($${offset},$${offset + 1},$${offset + 2})`;
    }
    const rows = (await this.pool.query(`
      SELECT normalized,dao_id AS "daoId",chain_id::text AS "chainId",
        proposal_id::text AS "proposalId",voter,support,reason,vote_weight::text AS "voteWeight",
        block_number::text AS "blockNumber",block_time AS timestamp,
        transaction_hash AS "transactionHash",log_index AS "logIndex",source_kind AS "sourceKind",
        source_endpoint AS "sourceEndpoint",source_public_endpoint AS "sourcePublicEndpoint",
        observed_head::text AS "observedHead"
      FROM vote_events WHERE ${where}
      ORDER BY block_number,lower(transaction_hash),log_index LIMIT $2
    `, params)).rows;
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    return { items, nextCursor: more ? encodeCursor(items.at(-1)) : null };
  }

  async status() {
    const counts = await this.pool.query(`
      SELECT (SELECT count(*)::int FROM daos) daos,
        (SELECT count(*)::int FROM proposals) proposals,
        (SELECT count(*)::int FROM vote_events) votes,
        (SELECT count(*)::int FROM delegation_events) delegations
    `);
    const checkpoints = await this.pool.query(`
      SELECT dao_id AS "daoId",source_id AS "sourceId",next_block::text AS "nextBlock",
        finalized_head::text AS "finalizedHead",updated_at AS "updatedAt",
        last_full_scan_at AS "lastFullScanAt",last_error AS "lastError"
      FROM sync_checkpoints ORDER BY dao_id,source_id
    `);
    return { ...counts.rows[0], tracking: await this.trackingCounts(), checkpoints: checkpoints.rows };
  }

  async syncStatus(daoId) {
    return (await this.pool.query(`
      SELECT dao_id AS "daoId",source_id AS "sourceId",next_block::text AS "nextBlock",
        finalized_head::text AS "finalizedHead",updated_at AS "updatedAt",
        last_full_scan_at AS "lastFullScanAt",last_error AS "lastError"
      FROM sync_checkpoints WHERE dao_id=$1 ORDER BY source_id
    `, [daoId])).rows;
  }
}

module.exports = { PostgresGovernanceStore, PostgresTransaction };
