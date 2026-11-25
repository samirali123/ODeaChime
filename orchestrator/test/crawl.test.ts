import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkSections, extractPage } from "../src/ingest/crawl.ts";

const HTML = `<!doctype html><html><head><title>Athletics | O'Dea</title><script>var x=1</script></head>
<body><nav><a href="/menu">Menu</a></nav>
<main>
  <h1>Athletics</h1><p>Go Irish!</p>
  <h2>Tryouts</h2><p>Fall tryouts begin in August.</p><ul><li>Bring a physical form.</li></ul>
  <a href="/athletics/football#top">Football</a> <a href="https://other.example/x">Elsewhere</a>
</main><footer>© O'Dea</footer></body></html>`;

test("extracts title, sections under headings, and absolute links", () => {
  const page = extractPage(HTML, "https://www.odea.org/athletics");
  assert.equal(page.title, "Athletics | O'Dea");
  assert.deepEqual(page.sections, [
    { heading: "Athletics", text: "Go Irish!" },
    { heading: "Tryouts", text: "Fall tryouts begin in August.\nBring a physical form." },
  ]);
  assert.ok(page.links.includes("https://www.odea.org/athletics/football"));
  assert.ok(page.links.includes("https://www.odea.org/menu")); // links are read before nav is stripped
});

test("chunks long sections without splitting paragraphs", () => {
  const para = "a".repeat(600);
  const chunks = chunkSections([{ heading: "H", text: [para, para, para].join("\n") }], 1500);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.heading === "H" && c.content.length <= 1500));
});
