# Greenfield policy ID normalizer

Create `src/normalize-policy-id.mjs` and export `normalizePolicyId(value)`.

- Accept a string, trim it, uppercase it, and replace runs of spaces or underscores with one hyphen.
- Preserve valid alphanumeric segments already separated by hyphens.
- Reject non-strings, empty results, punctuation, and empty segments.
- Use only the Node.js platform; add no dependencies or network access.
