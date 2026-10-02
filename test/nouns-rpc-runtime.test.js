const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRuntime } = require('../bin/gavel-indexer');

test('Nouns runtime uses mainnet RPC without constructing the deprecated subgraph transport', () => {
  const keys = ['INDEXER_ENABLED_DAOS', 'ETHEREUM_RPC_URL', 'NOUNS_SUBGRAPH_URL'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.INDEXER_ENABLED_DAOS = 'nouns';
    process.env.ETHEREUM_RPC_URL = 'https://rpc.example/';
    process.env.NOUNS_SUBGRAPH_URL = 'https://unreachable.invalid/subgraph';
    const { sources, provider } = buildRuntime({});
    assert.equal(sources.nouns.constructor.name, 'NounsRpcSource');
    assert.equal(sources.nouns.id, 'nouns-subgraph');
    assert.equal(sources.nouns.config.currentGovernor.toLowerCase(), '0x6f3e6272a167e8accb32072d08e0957f9c79223d');
    assert.equal(sources.nouns.provider, provider);
    assert.equal(sources.nouns.rpcUrl, process.env.ETHEREUM_RPC_URL);
    assert.equal(sources.nouns.endpoint, undefined);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
