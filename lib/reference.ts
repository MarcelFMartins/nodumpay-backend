/**
 * O `external_reference` de toda cobrança do hub é `<slug do app>:<referência>`.
 * É isso que deixa o hub saber para qual sistema devolver cada pagamento.
 */

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/;

export interface ParsedReference {
  /** Null quando a referência não tem prefixo (cobranças antigas). */
  slug: string | null;
  reference: string;
}

export function buildReference(slug: string, reference: string): string {
  return `${slug}:${reference}`;
}

export function parseReference(raw: string | null | undefined): ParsedReference | null {
  if (!raw) return null;
  const index = raw.indexOf(":");
  if (index > 0) {
    const slug = raw.slice(0, index);
    const reference = raw.slice(index + 1);
    if (SLUG_PATTERN.test(slug) && reference) return { slug, reference };
  }
  return { slug: null, reference: raw };
}
