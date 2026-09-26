#!/usr/bin/env node
const { parseArgs } = require("node:util");
const { JsonRpcProvider } = require("ethers");
const { validateIndexedEnsProposal } = require("../src/ens-reconcile");
const { fetchRailgunProposal, fetchRailgunProposalCount } = require("../src/railgun-proposal");
const {
  DAO_CONFIGS,
  PostgresGovernanceStore,
  GovernanceSyncWorker,
  EnsGovernorSource,
  RailgunVotingSource,
  NounsSubgraphSource,
  createReadOnlyApi,
} = require("../src");
const { redactErrorMessage } = require("../src/redaction");
const { resolveLogBlockBatchSize } = require("../src/domain/block-range");

const level = process.env.LOG_LEVEL || "info";
const rank = { debug: 0, info: 1, warn: 2, error: 3 };
const log = Object.fromEntries(["debug", "info", "warn", "error"].map((name) => [name, (value) => {
  if ((rank[name] ?? 1) >= (rank[level] ?? 1)) {
    process.stderr.write(`${JSON.stringify({ level: name, time: new Date().toISOString(), ...value })}\n`);
  }
}]));

function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function integer(value, name, min = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min) throw new TypeError(`${name} must be an integer >= ${min}`);
  return number;
}
function usage() {
  return "Usage: gavel-indexer <command> [--dao <dao>]\n" +
    "  migrate\n" +
    "  backfill --dao nouns|ens|railgun-eth [--from-block N] [--to-block N]\n" +
    "  sync --dao nouns|ens|railgun-eth\n" +
    "  sync --all\n" +
    "  status\n" +
    "  health\n" +
    "  reconcile --dao nouns|ens|railgun-eth\n" +
    "  ensure-roles\n" +
    "  verify-permissions [--role gavel_api] [--expect read-only|read-write] [--allow-catalog-fallback]\n" +
    "  serve\n" +
    "  run\n\n" +
    "A positional DAO is also accepted. RAILGUN_FROM_BLOCK optionally overrides the verified default.\n" +
    "INDEXER_BLOCK_BATCH_SIZE bounds every eth_getLogs span; ENS_PROPOSAL_BLOCK_BATCH_SIZE overrides it for ENS proposal discovery.\n";
}
function store() {
  return new PostgresGovernanceStore({
    maxConnections: integer(process.env.INDEXER_DB_POOL_SIZE || "10", "INDEXER_DB_POOL_SIZE", 2),
  });
}
function enabled() {
  return (process.env.INDEXER_ENABLED_DAOS || "nouns,ens").split(",").map((value) => value.trim()).filter(Boolean);
}
function healthStatus(status, daoIds = enabled(), options = {}) {
  const checkpoints = Array.isArray(status?.checkpoints) ? status.checkpoints : [];
  const maxAgeMs = Number(options.maxAgeSeconds ?? process.env.INDEXER_MAX_CHECKPOINT_AGE_SECONDS ?? 900) * 1000;
  const now = Number(options.now ?? Date.now());
  const missing = [];
  for (const daoId of daoIds) {
    const sourceId = DAO_CONFIGS[daoId]?.source?.id;
    if (!sourceId || !checkpoints.some((row) => row.daoId === daoId && row.sourceId === sourceId)) {
      missing.push(`${daoId}:${sourceId || "unknown-source"}`);
    }
  }
  const enabledSet = new Set(daoIds);
  const errors = checkpoints
    .filter((row) => enabledSet.has(row.daoId) && row.lastError)
    .map(({ daoId, sourceId, lastError }) => ({ daoId, sourceId, lastError }));
  // A checkpoint that stopped advancing is a stalled indexer. Without this an
  // indexer that died cleanly reports healthy forever.
  const stale = checkpoints
    .filter((row) => enabledSet.has(row.daoId))
    .map((row) => ({ daoId: row.daoId, sourceId: row.sourceId, ageSeconds: Math.round((now - new Date(row.updatedAt).getTime()) / 1000) }))
    .filter((row) => !Number.isFinite(row.ageSeconds) || row.ageSeconds * 1000 > maxAgeMs);
  return { ok: missing.length === 0 && errors.length === 0 && stale.length === 0, missing, errors, stale, checkpoints };
}
function buildRuntime(db) {
  const rpcUrl = process.env.ETHEREUM_RPC_URL;
  const sources = {};
  // Every `eth_getLogs` span in the indexer comes from here so a single setting
  // keeps the deployment inside whatever ceiling the configured provider
  // enforces. ENS proposal discovery may narrow it further via
  // ENS_PROPOSAL_BLOCK_BATCH_SIZE; see EnsGovernorSource.
  const blockBatchSize = resolveLogBlockBatchSize({ names: ["INDEXER_BLOCK_BATCH_SIZE"] });
  let provider;
  const common = {
    finalityDepth: integer(process.env.INDEXER_CONFIRMATION_DEPTH || "64", "INDEXER_CONFIRMATION_DEPTH"),
    replayBlocks: 64,
  };
  const daoIds = enabled();
  if (daoIds.length) {
    if (!rpcUrl) throw new Error("ETHEREUM_RPC_URL is required for canonical block provenance");
    provider = new JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
  }
  if (daoIds.includes("nouns")) sources.nouns = new NounsSubgraphSource({ ...common, provider });
  if (daoIds.includes("ens")) {
    sources.ens = new EnsGovernorSource({ ...common, provider, rpcUrl, fromBlock: DAO_CONFIGS.ens.fromBlock });
  }
  if (daoIds.includes("railgun-eth")) {
    const fromBlock = process.env.RAILGUN_FROM_BLOCK || String(DAO_CONFIGS["railgun-eth"].fromBlock);
    sources["railgun-eth"] = new RailgunVotingSource({
      ...common,
      provider,
      rpcUrl,
      fromBlock: integer(fromBlock, "RAILGUN_FROM_BLOCK", 1),
      proposalLoader: (id, blockTag) => fetchRailgunProposal({ provider, proposalId: id, blockTag }),
      proposalCountLoader: (blockTag) => fetchRailgunProposalCount({ provider, blockTag }),
    });
  }
  log.info({ event: "rpc_block_ranges", blockBatchSize, ensProposalBatchSize: sources.ens ? sources.ens.proposalBatchSize : null });
  const worker = new GovernanceSyncWorker({
    store: db,
    sources,
    batchSize: blockBatchSize,
    concurrency: integer(process.env.INDEXER_RPC_CONCURRENCY || "4", "INDEXER_RPC_CONCURRENCY", 1),
    fullScanIntervalMs: integer(process.env.INDEXER_FULL_SCAN_INTERVAL_SECONDS || "21600", "INDEXER_FULL_SCAN_INTERVAL_SECONDS", 60) * 1000,
    warmRefreshIntervalMs: integer(process.env.INDEXER_WARM_REFRESH_SECONDS || "900", "INDEXER_WARM_REFRESH_SECONDS", 0) * 1000,
    logger: log,
  });
  return { worker, provider, sources };
}

// Reconciliation is the exceptional path: a full enumeration that is authoritative
// about which proposals still exist, plus whatever canonical audit a DAO supports.
// Ordinary lifecycle correctness does not depend on it -- the incremental path
// derives and terminalizes on its own.
async function reconcile(db, worker, provider, daoId) {
  const sync = await worker.syncDao(daoId, { fullProposalScan: true });
  if (daoId !== "ens") return { ok: true, dao: daoId, sync };
  const audit = await reconcileEns(db, provider);
  return { ...audit, sync };
}

async function reconcileEns(db, provider) {
  let cursor = null;
  let checked = 0;
  let mismatches = 0;
  do {
    const page = await db.listProposals({ daoId: "ens", limit: 100, cursor });
    for (const indexed of page.items) {
      checked += 1;
      try { await validateIndexedEnsProposal({ provider, indexed }); }
      catch (error) {
        mismatches += 1;
        log.error({ event: "reconcile_mismatch", dao: "ens", proposalId: indexed.id, error: redactErrorMessage(error) });
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { ok: mismatches === 0, dao: "ens", checked, mismatches };
}

async function serve(db, values) {
  const port = integer(values.port || process.env.API_PORT || "8080", "API_PORT", 1);
  const host = process.env.API_HOST || "0.0.0.0";
  const server = createReadOnlyApi({ store: db, logger: log });
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, host, resolve));
  log.info({ event: "api_listening", host, port });
  const stop = () => server.close(() => db.close().finally(() => process.exit(0)));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

async function runContinuously(db, worker, interval) {
  let timer = null;
  let stopping = false;
  let active = Promise.resolve();
  const cycle = async () => {
    try { await worker.syncAll(); }
    catch (error) { log.error({ event: "sync_cycle_failed", error: redactErrorMessage(error) }); }
    if (!stopping) timer = setTimeout(() => { active = cycle(); }, interval);
  };
  active = cycle();
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    await active;
    await db.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await active;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(usage());
    return;
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dao: { type: "string" },
      all: { type: "boolean" },
      "from-block": { type: "string" },
      "to-block": { type: "string" },
      port: { type: "string" },
      role: { type: "string" },
      expect: { type: "string" },
      "allow-missing-roles": { type: "boolean" },
      "allow-catalog-fallback": { type: "boolean" },
      "skip-role-setup": { type: "boolean" },
      full: { type: "boolean" },
      "interval-ms": { type: "string" },
    },
  });
  const db = store();
  let close = true;
  try {
    if (command === "migrate") {
      const result = await db.migrate({ ensureRoles: !values["skip-role-setup"] });
      output(result);
      // The deployment gate: a schema that applied while the least-privilege
      // roles are missing or wrong must not read as success.
      if (!result.ok || (result.roles !== "granted" && !values["allow-missing-roles"])) process.exitCode = 2;
      return;
    }
    if (command === "ensure-roles") {
      const result = await db.ensureRoles();
      const roles = await db.rolesStatus();
      output({ ok: result.state !== "skipped", ...result, roles });
      if (result.state === "skipped") process.exitCode = 2;
      return;
    }
    if (command === "status") return output(await db.status());
    if (command === "verify-permissions") {
      const result = await db.verifyPermissions(values.role || "gavel_api", {
        expect: values.expect || "read-only",
        allowCatalogFallback: values["allow-catalog-fallback"] === true,
      });
      output(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (command === "health") {
      const result = healthStatus(await db.status());
      output(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (command === "serve") {
      close = false;
      await serve(db, values);
      return;
    }

    const { worker, provider, sources } = buildRuntime(db);
    const dao = values.dao || positionals[0];
    if (command === "backfill" || command === "sync") {
      const options = {};
      if (values["from-block"]) options.fromBlock = integer(values["from-block"], "from-block", 1);
      if (values["to-block"]) options.toBlock = integer(values["to-block"], "to-block", 1);
      if (command === "backfill" || values.full) options.fullProposalScan = true;
      if (values.all) {
        if (command !== "sync") throw new Error("--all is only valid with sync");
        return output({ ok: true, results: await worker.syncAll(options) });
      }
      if (!dao || !sources[dao]) throw new Error(`DAO must be enabled in INDEXER_ENABLED_DAOS: ${enabled().join(",")}`);
      return output(await worker.syncDao(dao, options));
    }
    if (command === "reconcile") {
      if (!dao || !sources[dao]) throw new Error(`DAO must be enabled in INDEXER_ENABLED_DAOS: ${enabled().join(",")}`);
      const result = await reconcile(db, worker, provider, dao);
      output(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    if (command === "run") {
      close = false;
      await runContinuously(db, worker, integer(values["interval-ms"] || "60000", "interval-ms", 1000));
      return;
    }
    throw new Error(`unknown command: ${command}`);
  } finally {
    if (close) await db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    log.error({ event: "fatal", error: redactErrorMessage(error) });
    process.exitCode = 1;
  });
}

module.exports = { buildRuntime, enabled, healthStatus, main, reconcile, runContinuously };
