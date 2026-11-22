export type EditionCandidate = {
  id: string;
  title: string;
  author: string;
  publisher: string;
  isbn: string | null;
  coverUrl: string;
  source: string;
  catalog: string;
};

export type EditionInput = {
  publisher: string;
  translator: string;
  language: string;
  edition: string;
  evidence: string;
  reviewed: boolean;
  linkIsbn: string;
  isbnConfirmed: boolean;
  isbnEvidence: string;
  candidateId: string;
  useArtwork: boolean;
  expectedRevision: number;
  expectedIsbn: string;
};

export type EditionDetails = {
  publisher: string; translator: string; language: string; edition: string;
  evidence: string; reviewed: boolean; revision: number; candidates: EditionCandidate[];
};
