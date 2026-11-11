export type BookCandidate = {
  id: number;
  title: string;
  slug: string;
};

export function normalizeIdentifier(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigramCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (value.length === 1) {
    counts.set(value, 1);
    return counts;
  }
  for (let i = 0; i < value.length - 1; i++) {
    const gram = value.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

// Dice coefficient over character bigrams; tolerant of small typos.
export function similarity(left: string, right: string): number {
  const a = bigramCounts(left);
  const b = bigramCounts(right);
  let overlap = 0;
  for (const [gram, count] of a) overlap += Math.min(count, b.get(gram) ?? 0);
  const total =
    [...a.values()].reduce((sum, n) => sum + n, 0) +
    [...b.values()].reduce((sum, n) => sum + n, 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}

export function findBookCandidates<T extends BookCandidate>(
  catalog: T[],
  identifier: string,
  limit = 3,
  threshold = 0.45,
): T[] {
  const query = normalizeIdentifier(identifier);
  return catalog
    .map((book) => {
      const title = normalizeIdentifier(book.title);
      let score = Math.max(
        similarity(query, title),
        similarity(query, normalizeIdentifier(book.slug.replace(/-/g, " "))),
      );
      if (
        query.length >= 4 &&
        (title.includes(query) || query.includes(title))
      ) {
        score = Math.max(score, 0.85);
      }
      return { book, score };
    })
    .filter((entry) => entry.score >= threshold)
    .sort(
      (a, b) => b.score - a.score || a.book.title.localeCompare(b.book.title),
    )
    .slice(0, limit)
    .map((entry) => entry.book);
}
