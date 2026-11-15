/**
 * Fields marked `secret()` (a PIN, password, credential, pairing code, grant, token or signed link), by operation,
 * read from the spec's `x-sail-secret` markers. A request carrying one is never frozen into a proposal, and a response
 * holding one is never stored for an idempotent replay: the register keeps only hashes of secrets.
 */
type Schema = Record<string, unknown>;
type Doc = { paths: Record<string, Record<string, { operationId?: string; requestBody?: { content?: Record<string, { schema?: Schema }> }; responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> }>>; components?: { schemas?: Record<string, Schema> } };
export type SecretFields = { request: string[]; response: boolean };

const byOp = new Map<string, SecretFields>();
const NONE: SecretFields = { request: [], response: false };

export function secretFieldsOf(op: string | undefined): SecretFields {
  return (op && byOp.get(op)) || NONE;
}

/** Every property name under `schema` that is marked secret, and whether the schema itself is. */
function marked(schema: unknown, doc: Doc, key: string | null, out: Set<string>, depth = 0): boolean {
  if (depth > 40 || !schema || typeof schema !== "object") return false;
  const s = schema as Schema;
  if (typeof s.$ref === "string") return marked(doc.components?.schemas?.[s.$ref.split("/").pop()!], doc, key, out, depth + 1);
  let self = s["x-sail-secret"] === true;
  if (self && key) out.add(key);
  for (const k of ["anyOf", "oneOf", "allOf"]) for (const x of (s[k] as unknown[] | undefined) ?? []) self = marked(x, doc, key, out, depth + 1) || self;
  if (s.items) self = marked(s.items, doc, key, out, depth + 1) || self;
  for (const [k, v] of Object.entries((s.properties as Record<string, unknown> | undefined) ?? {})) marked(v, doc, k, out, depth + 1);
  return self;
}

export function loadSecretMarkers(doc: Doc): void {
  byOp.clear();
  for (const methods of Object.values(doc.paths))
    for (const o of Object.values(methods)) {
      if (!o.operationId) continue;
      const request = new Set<string>();
      for (const c of Object.values(o.requestBody?.content ?? {})) marked(c.schema, doc, null, request);
      const inResponse = new Set<string>();
      let whole = false;
      for (const [status, r] of Object.entries(o.responses ?? {})) if (status.startsWith("2")) for (const c of Object.values(r.content ?? {})) whole = marked(c.schema, doc, null, inResponse) || whole;
      if (request.size || inResponse.size || whole) byOp.set(o.operationId, { request: [...request], response: whole || inResponse.size > 0 });
    }
}

/** Does this body carry a value under any of these keys, at any depth? */
export function carriesSecret(body: unknown, keys: readonly string[], depth = 0): boolean {
  if (!keys.length || depth > 30 || !body || typeof body !== "object") return false;
  if (Array.isArray(body)) return body.some((v) => carriesSecret(v, keys, depth + 1));
  return Object.entries(body as Record<string, unknown>).some(([k, v]) => (keys.includes(k) && v != null) || carriesSecret(v, keys, depth + 1));
}
