const { isCredentialKey, sanitizeConnectionUri } = require("./provenance");

function redactErrorMessage(error) {
  let message = String(error?.message || error || "operation failed");
  message = message.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (value) => {
    if (/^https?:/i.test(value)) {
      try { return new URL(value).origin; }
      catch { return "[redacted-url]"; }
    }
    return sanitizeConnectionUri(value);
  });
  message = message.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  message = message.replace(/(["']?)([a-z][a-z0-9_-]*)\1(\s*[:=]\s*)(?:(["'])(.*?)\4|([^\s,;}]+))/gi, (whole, quoteKey, key, separator, quoteValue) => {
    if (!isCredentialKey(key)) return whole;
    return `${quoteKey}${key}${quoteKey}${separator}${quoteValue || ""}[redacted]${quoteValue || ""}`;
  });
  return message.slice(0, 1000);
}

module.exports = { redactErrorMessage };
