const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const ACTION_KEYS = ["actionIndex", "calldata", "signature", "target", "valueWei"];
const MAX_INT4 = 2_147_483_647;

function canonicalGateAction(value, { exact = false, indexKey = "actionIndex" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("proposal action is invalid");
  if (exact && Object.keys(value).sort().join("\0") !== ACTION_KEYS.join("\0")) {
    throw new TypeError("proposal action keys are invalid");
  }
  const actionIndex = value[indexKey];
  if (!Number.isSafeInteger(actionIndex) || actionIndex < 0 || actionIndex > MAX_INT4) throw new TypeError("proposal action index is invalid");
  if (typeof value.target !== "string" || !ADDRESS.test(value.target)) throw new TypeError("proposal action target is invalid");
  if (typeof value.valueWei !== "string" || !UINT.test(value.valueWei)) throw new TypeError("proposal action value is invalid");
  if (typeof value.signature !== "string") throw new TypeError("proposal action signature is invalid");
  if (typeof value.calldata !== "string" || !HEX_BYTES.test(value.calldata)) throw new TypeError("proposal action calldata is invalid");
  return { actionIndex, target: value.target, valueWei: value.valueWei, signature: value.signature, calldata: value.calldata };
}

function canonicalGateActions(values, options = {}) {
  if (!Array.isArray(values)) throw new TypeError("proposal actions are invalid");
  return Array.from(values, (value, position) => {
    const action = canonicalGateAction(value, options);
    if (action.actionIndex !== position) throw new TypeError("proposal action index is invalid");
    return action;
  });
}

module.exports = { canonicalGateAction, canonicalGateActions };
