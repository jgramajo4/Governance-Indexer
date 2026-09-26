const { z } = require("zod");

const Support = Object.freeze({
  AGAINST: "AGAINST",
  FOR: "FOR",
  ABSTAIN: "ABSTAIN",
});

const supportSchema = z.enum(Object.values(Support));
const decimalStringSchema = z.string().regex(/^\d+$/, "expected an unsigned integer string");
const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, "expected 0x-prefixed hex");
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected an EVM address");
const daoIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "expected a DAO adapter id");
const proposalIdentitySchema = z.object({
  dao: daoIdSchema,
  chainId: z.number().int().positive(),
  governorAddress: addressSchema,
  proposalId: z.string().regex(/^(0|[1-9][0-9]*)$/, "expected a canonical proposal id"),
}).strict();

const proposalActionSchema = z.object({
  index: z.number().int().nonnegative(),
  target: addressSchema,
  valueWei: decimalStringSchema,
  signature: z.string(),
  calldata: hexSchema,
});

const normalizedProposalSchema = z.object({
  id: decimalStringSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string(),
  description: z.string(),
  proposer: addressSchema,
  // `state` is the raw upstream value and `outcome` Gavel's derived verdict.
  // Both keep their existing meaning; the lifecycle fields below name those
  // semantics explicitly and are optional so documents written before the
  // lifecycle model still parse.
  state: z.string().min(1),
  outcome: z.string().min(1),
  sourceState: z.string().min(1).optional(),
  effectiveStatus: z.string().min(1).optional(),
  trackingState: z.enum(["HOT", "WARM", "FINAL"]).optional(),
  lifecycleReason: z.string().min(1).optional(),
  createdBlock: decimalStringSchema,
  createdAt: z.string().datetime(),
  startBlock: decimalStringSchema,
  endBlock: decimalStringSchema,
  quorumVotes: decimalStringSchema,
  forVotes: decimalStringSchema,
  againstVotes: decimalStringSchema,
  abstainVotes: decimalStringSchema,
  actions: z.array(proposalActionSchema),
  dao: daoIdSchema.optional(),
  chainId: z.number().int().positive().optional(),
  venue: z.string().min(1).optional(),
  timing: z.enum(["block", "timestamp"]).optional(),
  startTime: z.string().datetime().nullable().optional(),
  endTime: z.string().datetime().nullable().optional(),
  metadataUrl: z.string().optional(),
  choices: z.array(supportSchema).min(2).optional(),
  identity: proposalIdentitySchema.optional(),
});

const sourceProvenanceSchema = z.object({
  kind: z.string().min(1),
  endpoint: z.string().url(),
  entityId: z.string().min(1),
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  subgraphBlock: decimalStringSchema,
  queriedAt: z.string().datetime(),
});

const normalizedVoteSchema = z.object({
  dao: daoIdSchema,
  chainId: z.number().int().positive(),
  proposalId: decimalStringSchema,
  proposalContentHash: z.string().regex(/^[0-9a-f]{64}$/),
  voter: addressSchema,
  support: supportSchema,
  reason: z.string().nullable(),
  blockNumber: decimalStringSchema,
  timestamp: z.string().datetime(),
  voteWeight: decimalStringSchema,
  clientId: z.number().int().min(0).max(0xffffffff),
  proposal: normalizedProposalSchema,
  source: sourceProvenanceSchema,
});

const historyDocumentSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    dao: daoIdSchema,
    chainId: z.number().int().positive(),
    voter: addressSchema,
    generatedAt: z.string().datetime(),
    source: z.object({
      kind: z.string().min(1),
      endpoint: z.string().url(),
      subgraphBlock: decimalStringSchema,
    }),
    voteCount: z.number().int().nonnegative(),
    votes: z.array(normalizedVoteSchema),
  })
  .refine((document) => document.voteCount === document.votes.length, {
    message: "voteCount must equal votes.length",
    path: ["voteCount"],
  });

module.exports = {
  Support,
  proposalIdentitySchema,
  proposalActionSchema,
  normalizedProposalSchema,
  normalizedVoteSchema,
  historyDocumentSchema,
};
