const { createHash } = require("node:crypto");
function proposalContentHash({ description = "", targets = [], values = [], signatures = [], calldatas = [] }) { return createHash("sha256").update(JSON.stringify({ description, targets, values, signatures, calldatas })).digest("hex"); }
module.exports = { proposalContentHash };
