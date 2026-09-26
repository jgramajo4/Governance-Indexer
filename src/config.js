const { getAddress } = require("ethers");

const DAO_CONFIGS = Object.freeze({
  ens: Object.freeze({
    id: "ens", name: "ENS", chainId: 1, governanceType: "openzeppelin-governor",
    contractAddress: getAddress("0x323A76393544d5ecca80cd6ef2A560C6a395b7E3"),
    currentGovernor: getAddress("0x323A76393544d5ecca80cd6ef2A560C6a395b7E3"),
    // Verified safe lower bound immediately before the Governor deployment era.
    fromBlock: 13699665,
    source: { id: "governor-logs", kind: "ens-governor-logs", endpoint: "ethereum-json-rpc" },
  }),
  "railgun-eth": Object.freeze({
    id: "railgun-eth", name: "Railgun Ethereum", chainId: 1, governanceType: "railgun-voting",
    contractAddress: getAddress("0xc480F68A3dcC3EdD82134FAB45C14A0FcF1dA3CC"),
    currentGovernor: getAddress("0xc480F68A3dcC3EdD82134FAB45C14A0FcF1dA3CC"),
    // Verified against the successful creation receipt, Railgun deployments,
    // and L2BEAT's Voting contract shape.
    fromBlock: 15505853,
    source: { id: "voting-logs", kind: "railgun-voting-logs", endpoint: "ethereum-json-rpc" },
  }),
  nouns: Object.freeze({
    id: "nouns", name: "Nouns DAO", chainId: 1, governanceType: "nouns-governor",
    // `contractAddress` is the NounsToken ERC-721, which is what every indexed
    // Nouns record has been keyed on since the first backfill; vote events are
    // unique on (chain_id, contract_address, transaction_hash, log_index), so
    // moving it would fork every existing row's identity. It stays, and the
    // governor gets named separately.
    contractAddress: getAddress("0x9C8fF314C9Bc7F6e59A9d9225Fb22946427eDC03"),
    tokenAddress: getAddress("0x9C8fF314C9Bc7F6e59A9d9225Fb22946427eDC03"),
    // The NounsDAOProxy. This previously repeated the token address, so anything
    // that took `currentGovernor` at its word and called `state(uint256)` on it
    // hit a contract with no such function. This is the address the vote
    // preparation adapter has always used.
    currentGovernor: getAddress("0x6f3E6272A167e8AcCb32072d08E0957F9c79223d"),
    fromBlock: 12985438,
    source: { id: "nouns-subgraph", kind: "nouns-subgraph", endpoint: "https://www.nouns.camp/subgraphs/nouns" },
  }),
});

module.exports = { DAO_CONFIGS };
