import type { EditionCandidate, EditionInput } from "./edition-types";

/** Stage catalog data for review; applying it is neither verification nor an ISBN write. */
export function applyEditionProposal(value: EditionInput, candidate: EditionCandidate): EditionInput {
  return { ...value, publisher: candidate.publisher, translator: candidate.translator ?? "", language: candidate.language ?? "",
    edition: candidate.edition ?? "", evidence: `Catalog proposal from ${candidate.catalog}: ${candidate.source}`,
    reviewed: false, candidateId: candidate.id, useArtwork: false,
    linkIsbn: value.expectedIsbn.startsWith("manual-") ? candidate.isbn ?? "" : "",
    isbnConfirmed: false, isbnEvidence: "" };
}
