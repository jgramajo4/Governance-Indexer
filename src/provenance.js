function sanitizeEndpoint(value, explicitPublicEndpoint) {
  const candidate = explicitPublicEndpoint || value;
  if (typeof candidate !== "string") return "source:unknown";
  try {
    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol)) return "source:unknown";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    if (!explicitPublicEndpoint) return url.origin;
    return url.toString().replace(/\/$/, url.pathname === "/" ? "" : "/");
  } catch {
    return /^[a-z0-9][a-z0-9._:-]*$/i.test(candidate) ? candidate : "source:unknown";
  }
}

function isCredentialKey(key) {
  const normalized = String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /(?:password|passwd|token|secret|apikey|authorization|privatekey|credentials|connectionstring|databaseurl|cookie)$/.test(normalized);
}

function sanitizeConnectionUri(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    const credentialQuery = [...url.searchParams.keys()].some(isCredentialKey);
    if (!url.username && !url.password && !credentialQuery) return value;
    return `${url.protocol}//${url.host}`;
  } catch { return "[redacted-uri]"; }
}

function sanitizeConfig(value, key = "") {
  if (isCredentialKey(key)) return value == null || value === "" ? value : "[redacted]";
  if (Array.isArray(value)) return value.map((item) => sanitizeConfig(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, sanitizeConfig(item, childKey)]));
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return sanitizeEndpoint(value);
  if (typeof value === "string") return sanitizeConnectionUri(value);
  return value;
}

function sanitizeProvenance(row) {
  const sanitized = sanitizeConfig({ ...row });
  if ("sourceEndpoint" in sanitized || "sourcePublicEndpoint" in sanitized) {
    sanitized.sourceEndpoint = sanitizeEndpoint(row.sourceEndpoint, row.sourcePublicEndpoint);
    sanitized.sourcePublicEndpoint = row.sourcePublicEndpoint
      ? sanitizeEndpoint(row.sourcePublicEndpoint, row.sourcePublicEndpoint)
      : undefined;
  }
  if ("endpoint" in sanitized) sanitized.endpoint = sanitizeEndpoint(row.endpoint, row.publicEndpoint);
  delete sanitized.publicEndpoint;
  delete sanitized.rpcUrl;
  if ("config" in sanitized) sanitized.config = sanitizeConfig(sanitized.config);
  return sanitized;
}

module.exports = { isCredentialKey, sanitizeConnectionUri, sanitizeEndpoint, sanitizeConfig, sanitizeProvenance };
