// Hosted Ethereum RPC providers cap the span a single `eth_getLogs` may cover,
// and 10,000 blocks is the common free-tier ceiling (dRPC among them). Every log
// scan in the monorepo therefore derives its span from this shared resolver
// instead of a per-source constant, so one setting keeps the whole system
// portable across providers.
const DEFAULT_LOG_BLOCK_BATCH_SIZE = 5000;

// Deliberately strict: only a plain decimal integer is accepted so a typo, a
// float, or an exponent form fails loudly at construction rather than silently
// producing a span the provider will reject at request time.
function parseBlockBatchSize(value, name) {
  const text = String(value).trim();
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < 1) {
    throw new RangeError(`${name} must be a positive integer number of blocks, received ${JSON.stringify(value)}`);
  }
  return number;
}

// Precedence is explicit option, then each environment variable in `names`
// order, then the safe default. An empty variable counts as unset; a variable
// that is set but unparseable throws instead of falling through, so a broken
// override is never masked by a lower-precedence value.
function resolveLogBlockBatchSize(options = {}) {
  const { explicit, explicitName = "blockBatchSize", names = [], env = process.env, fallback = DEFAULT_LOG_BLOCK_BATCH_SIZE } = options;
  if (explicit != null) return parseBlockBatchSize(explicit, explicitName);
  for (const name of names) {
    const value = env?.[name];
    if (value == null || String(value).trim() === "") continue;
    return parseBlockBatchSize(value, name);
  }
  return parseBlockBatchSize(fallback, "fallback block batch size");
}

// Inclusive [fromBlock, toBlock] spans, none wider than `batchSize` blocks.
function* blockRanges(fromBlock, toBlock, batchSize) {
  const size = parseBlockBatchSize(batchSize, "blockBatchSize");
  const last = Number(toBlock);
  for (let from = Number(fromBlock); from <= last; from += size) {
    yield { fromBlock: from, toBlock: Math.min(last, from + size - 1) };
  }
}

module.exports = { DEFAULT_LOG_BLOCK_BATCH_SIZE, parseBlockBatchSize, resolveLogBlockBatchSize, blockRanges };
