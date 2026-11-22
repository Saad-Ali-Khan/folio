"use client";

import { useEffect, useState } from "react";
import type { EditionDetails, EditionInput } from "@/lib/edition-types";
import { BookCover } from "./book-cover";
import { applyEditionProposal } from "@/lib/edition-proposals";

const field = "mt-2 block w-full rounded-lg border border-ink/20 bg-white px-3 py-2 font-normal";

function editable(details: EditionDetails, isbn: string): EditionInput {
  return { publisher: details.publisher, translator: details.translator, language: details.language, edition: details.edition,
    evidence: details.evidence, reviewed: details.reviewed, linkIsbn: "", isbnConfirmed: false, isbnEvidence: "",
    candidateId: "", useArtwork: false, expectedRevision: details.revision, expectedIsbn: isbn };
}

export function EditionFields({ bookId, isbn, value, onChange, onExpired, disabled, onSearchingChange }: {
  bookId: number; isbn: string; value: EditionInput | null;
  onChange: (input: EditionInput | null) => void; onExpired: () => void;
  disabled: boolean; onSearchingChange: (busy: boolean) => void;
}) {
  const [details, setDetails] = useState<EditionDetails | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [searching, setSearching] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/admin/books/edition?bookId=${bookId}`, { cache: "no-store", signal: controller.signal });
        if (response.status === 401) { onExpired(); return; }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (data.isbn !== isbn) throw new Error("This ISBN changed. Close the editor and refresh inventory.");
        if (controller.signal.aborted) return;
        setDetails(data.edition);
        onChange(editable(data.edition, isbn));
        setError("");
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Edition details could not load."); }
    }
    void load();
    return () => controller.abort();
  }, [bookId, isbn, onChange, onExpired, reload]);

  async function search() {
    if (!value) return;
    setSearching(true); onSearchingChange(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/books/edition/candidates", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, expectedRevision: value.expectedRevision }) });
      if (response.status === 401) { onExpired(); return; }
      if (response.status === 404 || response.status === 405) throw new Error("Cover search runs on the local Folio admin while your PC is on. Saved candidates can be reviewed here.");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setDetails(data.edition);
      onChange({ ...value, expectedRevision: data.edition.revision, candidateId: "", useArtwork: false });
      setNotice(data.found ? "Catalog proposals loaded. Compare the covers and inspect your copy before using them." : "No confident proposals found. Enter details from the physical title or copyright page.");
    } catch (error) { setError(error instanceof Error ? error.message : "Cover search failed."); }
    finally { setSearching(false); onSearchingChange(false); }
  }

  return <fieldset className="space-y-4 rounded-xl border border-ink/15 p-4" disabled={searching || disabled}>
    <legend className="px-2 font-display text-xl">Edition details</legend>
    <p className="text-xs leading-relaxed text-ink/60">Leave uncertain details blank. Cover similarity identifies a proposal; it does not verify the translator or the ISBN of your copy.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error} {!value && <button type="button" className="underline" onClick={() => setReload(reload + 1)}>Retry loading</button>}</p>}
    {!value ? <p role="status" className="text-sm text-ink/60">{error ? "Edition details unavailable. Resolve this before saving." : "Loading edition details…"}</p> : <>
      <div className="grid gap-4 sm:grid-cols-2">
        {([['publisher', 'Publisher'], ['translator', 'Translator'], ['language', 'Language'], ['edition', 'Edition / printing']] as const).map(([key, label]) =>
          <label key={key} className="block text-sm font-medium" htmlFor={`edition-${key}`}>{label}<input id={`edition-${key}`} className={field}
            value={value[key]} maxLength={key === 'language' ? 100 : 300} onChange={event => onChange({ ...value, [key]: event.target.value, reviewed: false })} /></label>)}
      </div>
      <label className="block text-sm font-medium" htmlFor="edition-evidence">Sources / evidence<textarea id="edition-evidence" className={field} rows={3}
        value={value.evidence} maxLength={3500} placeholder="Publisher: copyright page. Translator: title page, or a reliable edition URL."
        onChange={event => onChange({ ...value, evidence: event.target.value, reviewed: false })} /></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={value.reviewed} onChange={event => onChange({ ...value, reviewed: event.target.checked })} />
        <span>I checked the entered details against the evidence. Only reviewed details will appear on the public listing.</span></label>
      <details className="border-t border-ink/10 pt-3">
        <summary className="cursor-pointer text-sm font-medium">Review catalog proposals ({details?.candidates.length ?? 0})</summary>
        <p className="my-3 text-xs text-ink/60">Use catalog details fills the fields reported by that source and stages its ISBN for review. Missing details stay blank. Check the physical copy before verifying or linking an ISBN.</p>
        <button type="button" className="rounded-full border border-ink/20 px-4 py-2 text-sm" onClick={() => void search()}>{searching ? "Searching…" : "Find proposals from saved cover"}</button>
        {notice && <p role="status" className="mt-3 text-sm text-accent">{notice}</p>}
        <div className="mt-3 space-y-3">{details?.candidates.map(candidate => <article key={candidate.id} className="flex gap-3 rounded-lg border border-ink/10 p-3">
          <BookCover src={candidate.coverUrl} title={candidate.title} className="h-28 w-20 shrink-0 rounded-sm" sizes="80px" />
          <div className="min-w-0 text-sm"><p className="font-medium">{candidate.title}</p><p>{candidate.author}</p><p>{candidate.publisher || "Publisher not recorded"}</p>
            {candidate.language && <p>Language: {candidate.language}</p>}{candidate.edition && <p>Edition: {candidate.edition}</p>}{candidate.translator && <p>Translator: {candidate.translator}</p>}
            <a className="text-accent underline" href={candidate.source} target="_blank" rel="noopener noreferrer">{candidate.catalog} source</a>
            {candidate.isbn && <p className="mt-1 text-xs text-ink/60">Catalog ISBN: {candidate.isbn} · physical copy unverified</p>}
            <button type="button" className="mt-2 rounded-full border border-ink/20 px-3 py-1 text-xs" onClick={() => {
              onChange(applyEditionProposal(value, candidate));
              setNotice("Catalog details filled. Review the fields above and ISBN section below before saving. Blank fields were not supplied by this source.");
            }}>{value.candidateId === candidate.id ? "Catalog details selected" : "Use catalog details"}</button>
            {value.candidateId === candidate.id && <label className="mt-2 flex gap-2 text-xs"><input type="checkbox" checked={value.useArtwork} onChange={event => onChange({ ...value, useArtwork: event.target.checked })} />Use this catalog cover when saving</label>}
          </div>
        </article>)}</div>
      </details>
      {isbn.startsWith("manual-") && <div className="space-y-3 border-t border-ink/10 pt-3">
        <label className="block text-sm font-medium" htmlFor="edition-isbn">Link the physical copy’s ISBN<input id="edition-isbn" className={field} maxLength={40}
          value={value.linkIsbn} placeholder="ISBN-10 or ISBN-13 from this copy" onChange={event => onChange({ ...value, linkIsbn: event.target.value, isbnConfirmed: false })} /></label>
        {value.linkIsbn && <>
          <p className="text-xs text-ink/60">Check your copy and tick the confirmation below to link this ISBN. Your confirmation and any matching catalog source are recorded automatically. <button type="button" className="underline" onClick={() => onChange({ ...value, linkIsbn: "", isbnConfirmed: false, isbnEvidence: "" })}>Keep ISBN unlinked</button></p>
          <label className="block text-sm" htmlFor="edition-isbn-evidence">ISBN note (optional)<input id="edition-isbn-evidence" className={field} maxLength={1000}
            value={value.isbnEvidence} placeholder="Optional details about the barcode or copyright page" onChange={event => onChange({ ...value, isbnEvidence: event.target.value })} /></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" required checked={value.isbnConfirmed} onChange={event => onChange({ ...value, isbnConfirmed: event.target.checked })} />
            <span>I verified this ISBN on the physical copy. Matching an existing listing will stop this save; it will not merge copies.</span></label>
        </>}
      </div>}
      <p className="text-xs text-ink/60">Edition changes are saved with the book using the Save button below.</p>
    </>}
  </fieldset>;
}
