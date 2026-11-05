export function SearchForm() {
  return (
    <form
      action="/"
      method="get"
      role="search"
      className="flex items-center gap-2"
    >
      <input
        type="search"
        name="q"
        placeholder="Search by title or author"
        aria-label="Search books"
        className="w-full rounded-full border border-ink/15 bg-white/70 px-4 py-2.5 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
      <button
        type="submit"
        className="shrink-0 rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-ink"
      >
        Search
      </button>
    </form>
  );
}
