const SECRET_PATTERNS = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g },
  { name: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  {
    name: "assigned secret",
    pattern: /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?(?!\$\{|<|\[|YOUR_|REPLACE|CHANGE)[A-Za-z0-9_./+=-]{12,}/gi,
  },
];

export function secretIndicators(value) {
  return [...new Set(secretMatches(value).map((item) => item.name))];
}

export function secretMatches(value, { maxMatches = 64 } = {}) {
  const text = String(value ?? "");
  const found = [];
  for (const scanner of SECRET_PATTERNS) {
    scanner.pattern.lastIndex = 0;
    for (const match of text.matchAll(scanner.pattern)) {
      found.push({ name: scanner.name, index: match.index ?? 0 });
      if (found.length >= maxMatches) return found;
    }
  }
  return found;
}

export function exactSecretMatches(value, secrets, {
  maxMatches = 64,
  maxSecrets = 128,
  maxEncodedSecretBytes = 64 * 1024,
} = {}) {
  const text = String(value ?? "");
  const found = [];
  const seen = new Set();
  for (const variant of exactSecretVariants(secrets, { maxSecrets, maxEncodedSecretBytes })) {
    let offset = 0;
    while (offset <= text.length - variant.length) {
      const index = text.indexOf(variant, offset);
      if (index < 0) break;
      const key = `${index}:${variant.length}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ name: "exact ephemeral secret", index });
        if (found.length >= maxMatches) return found;
      }
      offset = index + Math.max(variant.length, 1);
    }
  }
  return found;
}

export function exactSecretVariants(secrets, {
  maxSecrets = 128,
  maxEncodedSecretBytes = 64 * 1024,
} = {}) {
  const eligible = [...new Set(
    (secrets ?? []).filter((secret) => typeof secret === "string" && secret.length >= 4),
  )];
  if (maxSecrets !== null) {
    if (!Number.isSafeInteger(maxSecrets) || maxSecrets < 1) {
      throw new Error("maxSecrets must be a positive safe integer or null");
    }
    if (eligible.length > maxSecrets) {
      throw Object.assign(
        new Error(`Exact secret input contains ${eligible.length} values; cap is ${maxSecrets}`),
        { code: "CREDENTIAL_VALUE_TOO_LARGE" },
      );
    }
  }
  const variants = new Set();
  for (const secret of eligible) {
    const json = JSON.stringify(secret);
    variants.add(secret);
    if (typeof json === "string" && json.length >= 2) variants.add(json.slice(1, -1));
    const bytes = Buffer.from(secret, "utf8");
    if (bytes.length <= maxEncodedSecretBytes) {
      const base64 = bytes.toString("base64");
      const base64Url = base64.replaceAll("+", "-").replaceAll("/", "_");
      const hex = bytes.toString("hex");
      variants.add(base64);
      variants.add(base64.replace(/=+$/, ""));
      variants.add(base64Url);
      variants.add(base64Url.replace(/=+$/, ""));
      variants.add(hex);
      variants.add(hex.toUpperCase());
      try { variants.add(encodeURIComponent(secret)); }
      catch {}
    }
  }
  return [...variants];
}
