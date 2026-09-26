const http = require("node:http");
const { getAddress } = require("ethers");
const { z } = require("zod");
const { decodeCursor, decodeProposalCursor } = require("./memory-store");
const { redactErrorMessage } = require("./redaction");
const { presentProposal } = require("./domain/lifecycle");
const { assertCanonicalProposalIdentity, canonicalProposalIdentity } = require("./domain/proposal-identity");
const { DAO_CONFIGS } = require("./config");
const { canonicalGateActions } = require("./gate-action");

const limitSchema = z.coerce.number().int().min(1).max(100).default(25);
const daoSchema = z.enum(["nouns", "ens", "railgun-eth"]);
const proposalSchema = z.string().regex(/^\d+$/).max(78);
const targetSchema = z.string().regex(/^(proposal:(0|[1-9][0-9]*)|candidate:0x[0-9a-f]{40}:0x[0-9a-f]{64})$/).max(128);
function json(res, status, body) { const payload = JSON.stringify(body); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" }); res.end(payload); }
function publicProposal(row, requestedDao = null, requestedId = null) {
  if (!row) return row;
  const presented = presentProposal(row.normalized || row, row);
  const dao = presented.dao || row.daoId || requestedDao;
  if ([presented.dao, row.daoId, row.dao, row.normalized?.dao].some((value) => value !== undefined && value !== dao)
    || requestedDao && dao !== requestedDao) throw new Error("Stored proposal DAO differs from requested DAO");
  const config = DAO_CONFIGS[dao];
  const proposalId = row.proposalId ?? presented.id;
  if (requestedId && proposalId !== requestedId) throw new Error("Stored proposal ID differs from requested ID");
  if (presented.id === undefined || presented.id !== proposalId) throw new Error("Stored proposal ID is missing or inconsistent");
  const identity = canonicalProposalIdentity({
    dao, chainId: config?.chainId, governorAddress: config?.currentGovernor, proposalId,
  });
  if ([row.chainId, row.normalized?.chainId].some((value) => value !== undefined && value !== identity.chainId)) {
    throw new Error("Stored proposal chain differs from configured chain");
  }
  if ([row.governorAddress, row.normalized?.governorAddress].some((value) => value !== undefined
    && (typeof value !== "string" || value.toLowerCase() !== identity.governorAddress))) {
    throw new Error("Stored proposal governor differs from configured governor");
  }
  for (const stored of [row.identity, row.normalized?.identity, presented.identity]) {
    if (stored !== undefined) assertCanonicalProposalIdentity(stored, identity);
  }
  return {
    ...presented,
    identity,
  };
}
function gateProposal(row) {
  if (!row) return row;
  return {
    chainId: row.chainId,
    governorAddress: row.governorAddress,
    proposalId: row.proposalId,
    title: row.title,
    proposer: row.proposer,
    refreshedAt: row.refreshedAt,
    sourceBlock: row.sourceBlock,
    sourceBlockHash: row.sourceBlockHash,
    effectiveStatus: row.effectiveStatus,
    contentHash: row.contentHash,
    actions: canonicalGateActions(row.actions || []),
  };
}
function gateTarget(row) {
  if (!row) return row;
  if (row.kind !== "candidate") return { targetId: `proposal:${row.proposalId}`, kind: "proposal", ...gateProposal(row) };
  return {
    dao: "nouns", targetId: row.targetId, kind: "candidate", proposer: row.proposer, slug: row.slug,
    title: row.title, description: row.description,
    refreshedAt: row.refreshedAt, sourceBlock: row.sourceBlock, sourceBlockHash: row.sourceBlockHash,
    nativeState: row.nativeState, eligibility: row.eligibility, mappingVersion: row.mappingVersion,
    contentHash: row.contentHash, actions: canonicalGateActions(row.actions || []),
  };
}
function publicEndpoint(value, explicit) {
  try {
    const url = new URL(explicit || value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return explicit ? url.toString().replace(/\/$/, url.pathname === "/" ? "" : "/") : url.origin;
  } catch { return "https://source.invalid"; }
}
function publicVote(row) {
  if (!row) return row;
  const { normalized, sourcePublicEndpoint, ...event } = row;
  // The normalized blob stays private (it embeds source transport detail), but
  // the two fields downstream materialization needs are surfaced explicitly so
  // an indexed history keeps the fidelity of a subgraph-generated one.
  return {
    ...event,
    clientId: Number(normalized?.clientId ?? 0),
    entityId: normalized?.source?.entityId ?? null,
    sourceEndpoint: publicEndpoint(event.sourceEndpoint, sourcePublicEndpoint),
  };
}
function publicCheckpoint(row) {
  return { ...row, lastError: row.lastError ? "sync_failed" : null };
}
function publicStatus(status) {
  return { ...status, checkpoints: (status.checkpoints || []).map(publicCheckpoint) };
}
function requestPath(value) {
  try { return new URL(value, "http://localhost").pathname; }
  catch { return String(value || "").split(/[?#]/, 1)[0] || "/"; }
}

function createReadOnlyApi({ store, logger = null }) {
  const log = logger || { info() {}, error() {} };
  return http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { error: "method_not_allowed" });
      const url = new URL(req.url, "http://localhost"); const parts = url.pathname.split("/").filter(Boolean);
      if (["/health", "/healthz"].includes(url.pathname)) return json(res, 200, { ok: true });
      if (url.pathname === "/v1/daos") return json(res, 200, { items: await store.listDaos() });
      if (url.pathname === "/v1/status") return json(res, 200, publicStatus(await store.status()));
      if (parts[0] === "v1" && parts[1] === "gate" && parts[2] === "daos" && parts[3] === "nouns"
        && parts[4] === "proposals" && parts.length === 6) {
        const id = proposalSchema.parse(parts[5]);
        const row = await store.getGateProposal("nouns", id);
        return row ? json(res, 200, gateProposal(row)) : json(res, 404, { error: "proposal_not_found" });
      }
      if (parts[0] === "v1" && parts[1] === "gate" && parts[2] === "daos" && parts[3] === "nouns"
        && parts[4] === "targets" && parts.length === 6) {
        const id = targetSchema.parse(decodeURIComponent(parts[5]));
        const row = await store.getGateTarget("nouns", id);
        return row ? json(res, 200, gateTarget(row)) : json(res, 404, { error: "target_not_found" });
      }
      if (parts[0] !== "v1" || parts[1] !== "daos") return json(res, 404, { error: "not_found" });
      const dao = daoSchema.parse(parts[2]); const limit = limitSchema.parse(url.searchParams.get("limit") || undefined);
      if (parts.length === 3) { const row = await store.getDao(dao); return row ? json(res, 200, row) : json(res, 404, { error: "dao_not_found" }); }
      if (parts[3] === "proposals" && parts.length === 4) {
        const cursor = decodeProposalCursor(url.searchParams.get("cursor"));
        const page = await store.listProposals({ daoId: dao, limit, cursor }); return json(res, 200, { ...page, items: (page.items || []).map((row) => publicProposal(row, dao)) });
      }
      if (parts[3] === "proposals" && parts.length === 5) { const id = proposalSchema.parse(parts[4]); const row = await store.getProposal(dao, id); return row ? json(res, 200, publicProposal(row, dao, id)) : json(res, 404, { error: "proposal_not_found" }); }
      if (parts[3] === "voters" && parts[5] === "history" && parts.length === 6) { const voter = getAddress(parts[4]); const cursor = decodeCursor(url.searchParams.get("cursor")); const page = await store.listVotes({ daoId: dao, voter, limit, cursor }); return json(res, 200, { dao, chainId: 1, voter, ...page, items: page.items.map(publicVote) }); }
      if (parts[3] === "votes" && parts.length === 4) { const voter = url.searchParams.get("voter"); const cursor = decodeCursor(url.searchParams.get("cursor")); const page = await store.listVotes({ daoId: dao, voter: voter ? getAddress(voter) : null, limit, cursor }); return json(res, 200, { ...page, items: page.items.map(publicVote) }); }
      if (parts[3] === "sync-status" && parts.length === 4) return json(res, 200, { dao, sources: (await store.syncStatus(dao)).map(publicCheckpoint) });
      return json(res, 404, { error: "not_found" });
    } catch (error) { const bad = error instanceof z.ZodError || error instanceof TypeError; log.error({ event: "api_error", method: req.method, path: requestPath(req.url), error: redactErrorMessage(error) }); return json(res, bad ? 400 : 500, { error: bad ? "invalid_request" : "internal_error", message: bad ? error.message : "Internal server error" }); }
    finally { log.info({ event: "http_request", method: req.method, path: requestPath(req.url), durationMs: Date.now() - started }); }
  });
}
module.exports = { createReadOnlyApi, publicEndpoint };
