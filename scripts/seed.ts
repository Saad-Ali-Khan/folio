import { count } from "drizzle-orm";
import { createDatabase } from "../lib/db";
import { books } from "../lib/db/schema";

const cover = (isbn: string) =>
  `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;

const seedBooks: Omit<typeof books.$inferInsert, "coverUrl">[] = [
  {
    isbn: "9780743273565",
    slug: "the-great-gatsby",
    title: "The Great Gatsby",
    author: "F. Scott Fitzgerald",
    description:
      "Jay Gatsby throws lavish parties in pursuit of the green light, observed by his uneasy neighbour Nick Carraway.",
    priceCents: 1299,
    stock: 14,
  },
  {
    isbn: "9780451524935",
    slug: "nineteen-eighty-four",
    title: "Nineteen Eighty-Four",
    author: "George Orwell",
    description:
      "Winston Smith rewrites history for a living and starts to wonder whether the Party can be beaten.",
    priceCents: 999,
    stock: 22,
  },
  {
    isbn: "9780061120084",
    slug: "to-kill-a-mockingbird",
    title: "To Kill a Mockingbird",
    author: "Harper Lee",
    description:
      "Scout Finch watches her father defend a Black man in a small Alabama town, and learns what courage costs.",
    priceCents: 1499,
    stock: 12,
  },
  {
    isbn: "9780547928227",
    slug: "the-hobbit",
    title: "The Hobbit",
    author: "J.R.R. Tolkien",
    description:
      "Bilbo Baggins leaves his comfortable hobbit-hole for a mountain, a dragon, and a ring he does not understand.",
    priceCents: 1699,
    stock: 18,
  },
  {
    isbn: "9780141439518",
    slug: "pride-and-prejudice",
    title: "Pride and Prejudice",
    author: "Jane Austen",
    description:
      "Elizabeth Bennet and Mr Darcy trade barbs, misread each other, and eventually arrive somewhere else entirely.",
    priceCents: 899,
    stock: 20,
  },
  {
    isbn: "9780316769488",
    slug: "the-catcher-in-the-rye",
    title: "The Catcher in the Rye",
    author: "J.D. Salinger",
    description:
      "Holden Caulfield drifts through New York after being expelled, allergic to phonies and unable to go home.",
    priceCents: 1099,
    stock: 9,
  },
  {
    isbn: "9780060850524",
    slug: "brave-new-world",
    title: "Brave New World",
    author: "Aldous Huxley",
    description:
      "A society engineered for happiness has no room left for the inconveniently human.",
    priceCents: 1399,
    stock: 11,
  },
  {
    isbn: "9780756404741",
    slug: "the-name-of-the-wind",
    title: "The Name of the Wind",
    author: "Patrick Rothfuss",
    description:
      "Kvothe recounts, over three days, how a gifted and reckless boy became a legend.",
    priceCents: 1899,
    stock: 7,
  },
  {
    isbn: "9780441172719",
    slug: "dune",
    title: "Dune",
    author: "Frank Herbert",
    description:
      "Paul Atreides is born into a desert war over the most valuable substance in the universe.",
    priceCents: 1199,
    stock: 15,
  },
  {
    isbn: "9780060883287",
    slug: "one-hundred-years-of-solitude",
    title: "One Hundred Years of Solitude",
    author: "Gabriel García Márquez",
    description:
      "Seven generations of the Buendía family live, love, and repeat themselves in the town of Macondo.",
    priceCents: 1699,
    stock: 8,
  },
  {
    isbn: "9780307387899",
    slug: "the-road",
    title: "The Road",
    author: "Cormac McCarthy",
    description:
      "A father and son walk south through a burnt America, carrying the fire.",
    priceCents: 1500,
    stock: 6,
  },
  {
    isbn: "9780062316097",
    slug: "sapiens",
    title: "Sapiens",
    author: "Yuval Noah Harari",
    description:
      "A brisk history of how Homo sapiens came to run the planet, and what we traded for it.",
    priceCents: 2299,
    stock: 13,
  },
  {
    isbn: "9780399590504",
    slug: "educated",
    title: "Educated",
    author: "Tara Westover",
    description:
      "A memoir of leaving an isolated survivalist home for Cambridge, and building a self of her own.",
    priceCents: 1700,
    stock: 10,
  },
  {
    isbn: "9780553418026",
    slug: "the-martian",
    title: "The Martian",
    author: "Andy Weir",
    description:
      "An astronaut is stranded on Mars and decides to science his way home.",
    priceCents: 1499,
    stock: 16,
  },
  {
    isbn: "9780316556347",
    slug: "circe",
    title: "Circe",
    author: "Madeline Miller",
    description:
      "The witch of Aiaia tells her own story, from overlooked nymph to exile to power.",
    priceCents: 1699,
    stock: 12,
  },
  {
    isbn: "9780593318171",
    slug: "klara-and-the-sun",
    title: "Klara and the Sun",
    author: "Kazuo Ishiguro",
    description:
      "An artificial friend watches a family closely and tries to understand love.",
    priceCents: 1700,
    stock: 5,
  },
  {
    isbn: "9781635575637",
    slug: "piranesi",
    title: "Piranesi",
    author: "Susanna Clarke",
    description:
      "A man lives alone in an infinite house of halls and statues, keeping careful notes.",
    priceCents: 1799,
    stock: 7,
  },
  {
    isbn: "9781400033416",
    slug: "beloved",
    title: "Beloved",
    author: "Toni Morrison",
    description:
      "Sethe's house in Ohio is haunted by the child she could not keep.",
    priceCents: 1400,
    stock: 9,
  },
];

async function main() {
  const { db, close } = await createDatabase();
  try {
    const rows = seedBooks.map((book) => ({
      ...book,
      status: "draft",
      coverUrl: cover(book.isbn),
    }));

    const inserted = await db
      .insert(books)
      .values(rows)
      .onConflictDoNothing({ target: books.isbn })
      .returning({ id: books.id });

    const [{ value }] = await db.select({ value: count() }).from(books);

    console.log(
      `Inserted ${inserted.length} new book(s). Catalog now has ${value}.`,
    );
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
