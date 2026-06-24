import { useState, useEffect, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const TABS = ["Research", "Study Planner", "Translator"];

const COLORS = {
  bg: "#0f0e17",
  surface: "#1a1828",
  card: "#221f35",
  accent: "#c8a96e",
  accentLight: "#e8c98e",
  text: "#f0ece2",
  muted: "#7e7a8a",
  border: "#2e2b40",
  green: "#5cba8e",
  red: "#e07070",
  blue: "#6fa3d8",
};

const systemFont = "'Crimson Pro', Georgia, serif";
const monoFont = "'DM Mono', 'Courier New', monospace";
const sansFont = "'DM Sans', sans-serif";

const LIBRARY_KEY = "scholarSuiteLibrary";
// Groq's free tier caps around 6,000-12,000 tokens/minute (input+output combined) for this
// model — far less than its 128k context window. We keep excerpts small and surface 429s clearly.
const EXCERPT_WINDOW_CHARS = 4000; // Arabic — denser tokenization, kept conservative
const LATIN_EXCERPT_WINDOW_CHARS = 9000; // English/transliterated — cheaper per character

async function callClaude(messages, systemPrompt, maxTokens = 1200) {
  const body = {
    model: "llama-3.3-70b-versatile",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  };
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) {
    const msg = /rate|429|limit/i.test(data.error)
      ? "Rate limit reached on the free Groq tier — wait about a minute and try again."
      : data.error;
    throw new Error(msg);
  }
  return data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// Shared book library — persisted in localStorage, used by Research and Translator
function useBookLibrary() {
  const [library, setLibrary] = useState([]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LIBRARY_KEY);
      if (saved) setLibrary(JSON.parse(saved));
    } catch (e) {
      console.error("Failed to load library", e);
    }
  }, []);

  function persist(next) {
    setLibrary(next);
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(next));
    } catch (e) {
      console.error("Failed to save library — storage may be full", e);
    }
  }

  function addBook(name, text) {
    const book = { id: Date.now().toString(), name, text, chars: text.length, dateAdded: new Date().toISOString() };
    persist([...library, book]);
    return book;
  }

  function removeBook(id) {
    persist(library.filter((b) => b.id !== id));
  }

  return { library, addBook, removeBook };
}

async function extractPdfText(file, onProgress) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let pageText = "";
    let lastY = null;

    for (const item of content.items) {
      const y = item.transform[5];
      const fontHeight = Math.abs(item.transform[3]) || 10;

      if (lastY !== null) {
        const dy = Math.abs(lastY - y);
        if (dy > fontHeight * 1.4) {
          pageText += "\n\n"; // big vertical jump — heading or paragraph break
        } else if (dy > fontHeight * 0.4) {
          pageText += "\n"; // normal new line
        } else {
          pageText += item.str.startsWith(" ") || pageText.endsWith(" ") ? "" : " ";
        }
      }

      pageText += item.str;
      lastY = y;
    }

    fullText += pageText + "\n\n";
    if (onProgress) onProgress(i, pdf.numPages);
  }
  return fullText.trim();
}

function localKeywordsFromTopic(topic) {
  return topic
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

// Walk backward from a keyword-match point to the nearest paragraph/section break
// (blank line), so the excerpt starts at the beginning of that section rather than
// mid-way through it — important for stories/narratives that need to be read from
// the start, not just wherever the keyword happens to cluster most densely.
function backUpToSectionStart(text, approxIndex, maxBack = 6000) {
  const searchFrom = Math.max(0, approxIndex - maxBack);
  const slice = text.slice(searchFrom, approxIndex);

  // Split into paragraph-like blocks on blank-line breaks
  const paraBreak = /\n\s*\n/g;
  let lastEnd = 0;
  const blocks = [];
  let m;
  while ((m = paraBreak.exec(slice)) !== null) {
    blocks.push({ start: lastEnd, end: m.index });
    lastEnd = m.index + m[0].length;
  }
  blocks.push({ start: lastEnd, end: slice.length });

  // Walk backward looking for a short, standalone block — likely a chapter/story title
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = slice.slice(blocks[i].start, blocks[i].end).trim();
    if (block.length > 0 && block.length < 60 && !block.includes("\n")) {
      return searchFrom + blocks[i].start;
    }
  }

  // No heading-like block found — fall back to the nearest blank-line break
  const breaks = [...slice.matchAll(/\n\s*\n/g)];
  if (breaks.length > 0) {
    const last = breaks[breaks.length - 1];
    return searchFrom + last.index + last[0].length;
  }
  return Math.max(0, approxIndex - 500);
}

function scoreAndFindExcerpt(fullText, keywords, windowChars) {
  if (!keywords || keywords.length === 0 || !fullText) return null;

  const scanChunk = 1500;
  const step = 750;
  let bestScore = 0;
  let bestStart = -1;
  const lowerFull = fullText.toLowerCase();

  for (let start = 0; start < fullText.length; start += step) {
    const chunk = lowerFull.slice(start, start + scanChunk);
    let score = 0;
    for (const kw of keywords) {
      const k = kw.toLowerCase().trim();
      if (!k) continue;
      score += chunk.split(k).length - 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  if (bestStart === -1) return null;

  const excerptStart = backUpToSectionStart(fullText, bestStart);
  const excerptEnd = Math.min(fullText.length, excerptStart + windowChars);
  return fullText.slice(excerptStart, excerptEnd);
}

// Classical Arabic PDFs mix diacritics (tashkeel) inconsistently and use different
// shapes for the same letter (إ أ آ ا are all "alef"). A literal search fails on tiny
// mismatches like this. We strip diacritics and unify letter variants before matching,
// while keeping a map back to the original character positions so the excerpt we
// return is the real, untouched text.
function normalizeArabicChar(ch) {
  if (/[\u064B-\u0652\u0670\u0640]/.test(ch)) return ""; // diacritics + tatweel — dropped
  if (/[إأآا]/.test(ch)) return "ا";
  if (ch === "ى") return "ي";
  if (ch === "ة") return "ه";
  return ch;
}

function normalizeArabicWithMap(text) {
  let normalized = "";
  const map = []; // map[i] = index in the original text that normalized[i] came from
  for (let i = 0; i < text.length; i++) {
    const nch = normalizeArabicChar(text[i]);
    if (nch === "") continue;
    normalized += nch;
    map.push(i);
  }
  return { normalized, map };
}

function normalizeArabicPlain(text) {
  let out = "";
  for (const ch of text) {
    out += normalizeArabicChar(ch);
  }
  return out;
}

function scoreAndFindExcerptArabic(fullText, keywords, windowChars) {
  if (!keywords || keywords.length === 0 || !fullText) return null;

  const { normalized, map } = normalizeArabicWithMap(fullText);

  // Expand each AI-given phrase into both the full phrase and its individual words —
  // PDF text extraction can introduce odd spacing, so matching single strong words too
  // makes this much more forgiving than requiring exact multi-word adjacency.
  const expanded = new Set();
  for (const kw of keywords) {
    const norm = normalizeArabicPlain(kw.trim());
    if (norm.length >= 2) expanded.add(norm);
    for (const word of norm.split(/\s+/)) {
      if (word.length >= 2) expanded.add(word);
    }
  }
  const kwList = Array.from(expanded);
  if (kwList.length === 0) return null;

  const scanChunk = 1800;
  const step = 900;
  let bestScore = 0;
  let bestStart = -1;

  for (let start = 0; start < normalized.length; start += step) {
    const chunk = normalized.slice(start, start + scanChunk);
    let score = 0;
    for (const kw of kwList) {
      score += chunk.split(kw).length - 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  if (bestStart === -1) return null;

  const originalStart = map[bestStart] ?? 0;
  const excerptStart = backUpToSectionStart(fullText, originalStart);
  const excerptEnd = Math.min(fullText.length, excerptStart + windowChars);
  return fullText.slice(excerptStart, excerptEnd);
}

// A plain literal search fails whenever the topic's wording doesn't exactly match the
// book's own wording — different spelling of a name (Nuh/Nooh/Noah), different phrasing
// ("story of X" vs. the book's actual heading), or Arabic script entirely. In all these
// cases we ask the AI for likely alternate keywords/spellings first (a tiny, cheap call)
// so the local search has real candidates to match against.
async function getAlternateKeywords(topic, isArabicScript) {
  try {
    const system = isArabicScript
      ? `Given a study topic (in English or transliteration), respond with ONLY 3-6 short Arabic words/phrases (in Arabic script) likely to appear in a classical Arabic text discussing this exact topic. Comma-separated. No English, no explanation, nothing else.`
      : `Given a study/research topic, respond with ONLY 3-6 short alternate keywords or phrasings likely to appear as a heading or in the body text of a book discussing this exact topic — including likely alternate spellings of any names involved (e.g. Nuh/Nooh/Noah, Yusuf/Yousuf/Joseph). Comma-separated. No explanation, nothing else.`;
    const text = await callClaude([{ role: "user", content: topic }], system, 80);
    return text
      .split(",")
      .map((s) => s.trim().replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, ""))
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

// Simple keyword-based search to find the most relevant chunk of a book for a given
// topic, so we only send a small, targeted excerpt to the AI instead of the whole text.
// Latin-script text tokenizes far more efficiently than Arabic, so we can afford a much
// bigger window for English/transliterated books within the same rate-limit budget.
async function findRelevantExcerpt(fullText, topic) {
  if (!fullText) return null;

  const looksArabic = /[\u0600-\u06FF]/.test(fullText.slice(0, 3000));
  const windowChars = looksArabic ? EXCERPT_WINDOW_CHARS : LATIN_EXCERPT_WINDOW_CHARS;

  if (looksArabic) {
    let excerpt = scoreAndFindExcerptArabic(fullText, localKeywordsFromTopic(topic), windowChars);
    if (excerpt) return excerpt;
    const arabicKeywords = await getAlternateKeywords(topic, true);
    excerpt = scoreAndFindExcerptArabic(fullText, arabicKeywords, windowChars);
    return excerpt;
  }

  const englishKeywords = localKeywordsFromTopic(topic);
  let excerpt = scoreAndFindExcerpt(fullText, englishKeywords, windowChars);
  if (excerpt) return excerpt;

  const altKeywords = await getAlternateKeywords(topic, false);
  excerpt = scoreAndFindExcerpt(fullText, [...englishKeywords, ...altKeywords], windowChars);
  return excerpt; // may be null — caller handles that honestly
}

// Finds where a pasted passage actually occurs in a selected book and returns the
// surrounding text — used by the Translator so the AI can see the real sentences
// around what's being translated (helps with pronouns, references, exact wording).
function findSurroundingContext(bookText, snippet, contextChars = 800) {
  if (!bookText || !snippet) return null;
  const looksArabic = /[\u0600-\u06FF]/.test(snippet);

  if (looksArabic) {
    const { normalized, map } = normalizeArabicWithMap(bookText);
    const normSnippet = normalizeArabicPlain(snippet.trim()).slice(0, 60);
    if (normSnippet.length < 10) return null;
    const idx = normalized.indexOf(normSnippet);
    if (idx === -1) return null;
    const originalIdx = map[idx] ?? 0;
    const start = Math.max(0, originalIdx - contextChars);
    const end = Math.min(bookText.length, originalIdx + normSnippet.length + contextChars);
    return bookText.slice(start, end);
  }

  const lower = bookText.toLowerCase();
  const snippetLower = snippet.trim().toLowerCase().slice(0, 60);
  if (snippetLower.length < 10) return null;
  const idx = lower.indexOf(snippetLower);
  if (idx === -1) return null;
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(bookText.length, idx + snippetLower.length + contextChars);
  return bookText.slice(start, end);
}

function BookLibraryPanel({ library, addBook, removeBook, selectedBookId, onSelectBook }) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null);
  const fileInputRef = useRef(null);

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setProgress({ current: 0, total: 0 });
    try {
      const text = await extractPdfText(file, (current, total) => setProgress({ current, total }));
      const name = file.name.replace(/\.pdf$/i, "");
      const book = addBook(name, text);
      onSelectBook(book.id);
    } catch (err) {
      alert("Couldn't read this PDF: " + err.message);
    }
    setUploading(false);
    setProgress(null);
    e.target.value = "";
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <label style={{ ...labelStyle, marginBottom: 0 }}>📚 My Books</label>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={{ background: "none", border: `1px solid ${COLORS.accent}55`, color: COLORS.accent, borderRadius: "6px", padding: "0.25rem 0.6rem", fontSize: "0.75rem", fontFamily: sansFont, cursor: uploading ? "not-allowed" : "pointer" }}
        >
          {uploading ? "Reading..." : "+ Add PDF"}
        </button>
        <input ref={fileInputRef} type="file" accept=".pdf" onChange={handleFileChange} style={{ display: "none" }} />
      </div>

      {uploading && progress && (
        <div style={{ fontFamily: sansFont, fontSize: "0.78rem", color: COLORS.muted, marginBottom: "0.5rem" }}>
          {progress.total ? `Reading page ${progress.current}/${progress.total}...` : "Opening PDF..."}
        </div>
      )}

      {library.length === 0 && !uploading && (
        <div style={{ fontFamily: sansFont, fontSize: "0.78rem", color: COLORS.muted, marginBottom: "0.5rem" }}>
          No books yet — upload a PDF once and it stays saved.
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
        {library.map((b) => (
          <div
            key={b.id}
            onClick={() => onSelectBook(b.id === selectedBookId ? null : b.id)}
            style={{
              display: "flex", alignItems: "center", gap: "0.4rem",
              padding: "0.3rem 0.6rem", borderRadius: "14px", cursor: "pointer",
              background: selectedBookId === b.id ? COLORS.accent + "22" : COLORS.surface,
              border: `1px solid ${selectedBookId === b.id ? COLORS.accent : COLORS.border}`,
            }}
          >
            <span style={{ fontFamily: sansFont, fontSize: "0.78rem", color: selectedBookId === b.id ? COLORS.accent : COLORS.text }}>
              {b.name}
            </span>
            <span
              onClick={(e) => { e.stopPropagation(); if (confirm(`Remove "${b.name}" from your library?`)) removeBook(b.id); }}
              style={{ color: COLORS.red, fontSize: "0.7rem", cursor: "pointer" }}
            >
              ✕
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResearchAssistant({ prefillNotes, prefillTopic, prefillBook }) {
  const [topic, setTopic] = useState(prefillTopic || "");
  const [notes, setNotes] = useState(prefillNotes || "");
  const [bookName, setBookName] = useState(prefillBook || "");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const { library, addBook, removeBook } = useBookLibrary();
  const [selectedBookId, setSelectedBookId] = useState(null);

  const selectedBook = library.find((b) => b.id === selectedBookId) || null;

  function handleSelectBook(id) {
    setSelectedBookId(id);
    const book = library.find((b) => b.id === id);
    setBookName(book ? book.name : "");
  }

  async function research() {
    if (!topic.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      // Build book context. If the user already pasted notes, we don't also need to
      // dump book text — that just burns tokens for no reason. The PDF excerpt only
      // matters when there's no pasted text and we need something to ground the AI.
      let bookContext = "";
      let bookTextBlock = "";
      let excerptNotFound = false;

      if (!notes.trim() && selectedBook) {
        const isArabicBook = /[\u0600-\u06FF]/.test(selectedBook.text.slice(0, 3000));
        const excerpt = await findRelevantExcerpt(selectedBook.text, topic);
        if (excerpt) {
          bookContext = `Below is an EXCERPT found by searching the actual book "${selectedBook.name}" for content matching the topic.${isArabicBook ? " It is in Arabic." : ""} Read it directly and base your notes ONLY on what this specific excerpt actually says — translate and structure its real content. Do NOT substitute a different classification, definition, or version of events you happen to know generally, even if it's a well-known one, if it doesn't match what's actually written in this excerpt. If the excerpt lists a specific number of types/categories, use exactly that number and those names. If the excerpt is a narrative/story, it may be cut off at the start or end of the window — cover everything that IS included, in the order it happens, without skipping ahead to a part later in the excerpt and ignoring the earlier part.`;
          bookTextBlock = `\n\n--- EXCERPT FROM "${selectedBook.name}"${isArabicBook ? " (Arabic)" : ""} ---\n${excerpt}\n--- END EXCERPT ---`;
        } else {
          excerptNotFound = true;
          bookContext = `The user has the book "${selectedBook.name}" but a text search for this topic inside it found no clear match — it may be phrased differently in the book, or this topic may be in a different part. Use your own knowledge of this book and topic instead, and don't pretend to quote the book directly.`;
        }
      } else if (bookName.trim()) {
        bookContext = `This content is from the book/source: "${bookName.trim()}". Use your knowledge of this specific work to give accurate context — its field, its scholarly tradition, its authors, and the technical meaning of terms within it.`;
      }

      const system = `You are a knowledgeable Islamic and classical studies scholar making study notes. Write in clear English but preserve all Arabic/Urdu technical terms exactly as they are — never replace Fasahat with "eloquence", never replace Tanafur e Huroof with "clashing letters". Keep the terms and explain them after a colon.

${bookContext}

CONTENT TYPE — pick the right structure for what's actually there:

If the source is a NARRATIVE/STORY (history, seerah, Qisas al-Anbiya, Quranic stories, biography):
- Retell it as a clear chronological sequence — what happened first, then next, then after that, in the order it actually occurs
- Use headers to mark major STAGES of the story (e.g. "The Persecution Begins", "Allah Commands the Ark", "The Flood"), not abstract themes pulled from random points
- Cover the full sequence of events that's actually in front of you — don't jump to a later part and present only that as if it were the whole story
- Bullet points are for breaking up long paragraphs into readable beats, not for chopping the story into disconnected trivia

If the source is DEFINITIONAL/CLASSIFICATORY (fiqh, usul, nahw, sarf, balaghah):
- Use ## headers, numbered lists for types/categories, - bullets for sub-points, **bold** for term names
- Name headers after the actual concepts (e.g. "Fasahat of Kalimah", "3 Types of Fasahat", "Linguistic Definition") — never generic ones like "Introduction to X" or "Key Points"
- Mirror the structure of the actual chapter — if it has types, list types; if it has definitions, start with definitions
- Follow this example:

## Fasahat — Linguistic Definition
- In the dictionary: what informs regarding clarity and apparent-ness (al-bayan wal-dhuhur)
- It is said: "The boy is most eloquent in his speech" — when his words become clear and apparent
- In terminology: a quality of the Word (Kalimah), Speech (Kalam), and Speaker (Mutakallim)

## 3 Types of Fasahat of Kalimah — it being free from:
1. **Tanafur e Huroof**: letters in a word that make it hard on the tongue e.g. الظَّشْن
2. **Mukhalifat al-Qiyas**: words not following the rules of Sarf e.g. بُوقات instead of أبواق
3. **Gharabah** (strangeness): a word used other than its apparent meaning e.g. تَكَأْكَأ instead of اجتمع

IF the user provides notes/a passage:
- Extract and structure the actual content — don't summarise loosely
- Keep all technical terms as-is
- Cover everything in it from start to finish

IF no notes provided but book/chapter given:
- Use your real knowledge of that specific chapter
- Give the actual definitions, types, conditions, events and examples from that source
- Do NOT give generic Islamic advice or relate it to Quran/hadith unless the chapter does so`;

      const userMsg = notes.trim()
        ? `Topic: ${topic}${bookName.trim() ? `\nSource: ${bookName.trim()}` : ""}\n\nText to make notes from:\n${notes}\n\nMake clear, focused notes based on this specific text, covering it completely from start to finish.`
        : `Topic: ${topic}${bookName.trim() ? `\nBook/Source: ${bookName.trim()}` : ""}\n\nGive me real, accurate notes on this specific topic from this specific source, covering it completely.${bookTextBlock}`;

      const text = await callClaude([{ role: "user", content: userMsg }], system, 2000);
      setResult(excerptNotFound ? `⚠️ No exact match found in your PDF for this topic — using general knowledge instead.\n\n${text}` : text);
      setHistory((h) => [{ topic, bookName, result: text }, ...h.slice(0, 4)]);
    } catch (e) {
      setResult("Error: " + e.message);
    }
    setLoading(false);
  }

  function formatBold(text) {
    const parts = text.split(/\*\*(.*?)\*\*/g);
    return parts.map((p, i) =>
      i % 2 === 1 ? <strong key={i} style={{ color: COLORS.accentLight }}>{p}</strong> : p
    );
  }

  function renderResult(text) {
    return text.split("\n").map((line, i) => {
      if (line.startsWith("## "))
        return (
          <h3 key={i} style={{ color: COLORS.accent, fontFamily: systemFont, fontSize: "1.2rem", margin: "1.2rem 0 0.4rem", borderBottom: `1px solid ${COLORS.border}`, paddingBottom: "0.3rem" }}>
            {formatBold(line.slice(3))}
          </h3>
        );
      if (line.startsWith("# "))
        return (
          <h2 key={i} style={{ color: COLORS.accentLight, fontFamily: systemFont, fontSize: "1.4rem", margin: "1rem 0 0.5rem" }}>
            {formatBold(line.slice(2))}
          </h2>
        );
      if (line.startsWith("- "))
        return (
          <div key={i} style={{ display: "flex", gap: "0.5rem", margin: "0.25rem 0", paddingLeft: "0.5rem" }}>
            <span style={{ color: COLORS.accent }}>▸</span>
            <span style={{ fontFamily: sansFont, fontSize: "0.9rem", color: COLORS.text, lineHeight: 1.6 }}>
              {formatBold(line.slice(2))}
            </span>
          </div>
        );
      if (line.trim() === "") return <div key={i} style={{ height: "0.5rem" }} />;
      return (
        <p key={i} style={{ fontFamily: sansFont, fontSize: "0.9rem", color: COLORS.text, lineHeight: 1.7, margin: "0.2rem 0" }}>
          {formatBold(line)}
        </p>
      );
    });
  }

  return (
    <div style={{ display: "flex", gap: "1.5rem", height: "100%" }}>
      <div style={{ width: "320px", flexShrink: 0, display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div>
          <label style={labelStyle}>Research Topic</label>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && research()}
            placeholder="e.g. Chapter of Amr, photosynthesis..."
            style={inputStyle}
          />
        </div>
        <div>
          <BookLibraryPanel
            library={library}
            addBook={addBook}
            removeBook={removeBook}
            selectedBookId={selectedBookId}
            onSelectBook={handleSelectBook}
          />
        </div>
        <div>
          <label style={labelStyle}>Book / Source (optional)</label>
          <input
            value={bookName}
            onChange={(e) => { setBookName(e.target.value); setSelectedBookId(null); }}
            placeholder="Type a name, or select a book above"
            style={inputStyle}
          />
          {selectedBook && (
            <div style={{ fontFamily: sansFont, fontSize: "0.75rem", color: COLORS.green, marginTop: "0.3rem" }}>
              ✓ Reading from your uploaded PDF ({selectedBook.chars.toLocaleString()} chars)
            </div>
          )}
        </div>
        <div>
          <label style={labelStyle}>Your Notes (optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Paste or write any notes you already have..."
            style={{ ...inputStyle, height: "120px", resize: "vertical" }}
          />
        </div>
        <button onClick={research} disabled={loading || !topic.trim()} style={btnStyle(loading || !topic.trim())}>
          {loading ? "Researching..." : "Research →"}
        </button>
        {history.length > 0 && (
          <div>
            <div style={{ fontFamily: sansFont, fontSize: "0.75rem", color: COLORS.muted, marginBottom: "0.5rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Recent</div>
            {history.map((h, i) => (
              <div
                key={i}
                onClick={() => { setTopic(h.topic); setBookName(h.bookName || ""); setResult(h.result); }}
                style={{ padding: "0.5rem 0.75rem", borderRadius: "6px", background: COLORS.card, marginBottom: "0.4rem", cursor: "pointer", border: `1px solid ${COLORS.border}` }}
              >
                <div style={{ fontFamily: sansFont, fontSize: "0.85rem", color: COLORS.text }}>{h.topic}</div>
                {h.bookName && <div style={{ fontFamily: sansFont, fontSize: "0.75rem", color: COLORS.muted }}>{h.bookName}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ flex: 1, background: COLORS.card, borderRadius: "12px", border: `1px solid ${COLORS.border}`, padding: "1.5rem", overflowY: "auto" }}>
        {loading && <LoadingDots label="Researching" />}
        {!loading && !result && (
          <div style={{ textAlign: "center", paddingTop: "4rem", color: COLORS.muted }}>
            <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>📚</div>
            <div style={{ fontFamily: systemFont, fontSize: "1.2rem" }}>Enter a topic to begin your research</div>
            <div style={{ fontFamily: sansFont, fontSize: "0.85rem", color: COLORS.muted, marginTop: "0.5rem" }}>Add a book name for more accurate results</div>
          </div>
        )}
        {!loading && result && renderResult(result)}
      </div>
    </div>
  );
}

function StudyPlanner() {
  const [subjects, setSubjects] = useState([]);
  const [newSubject, setNewSubject] = useState("");
  const [selected, setSelected] = useState(null);
  const [newTopic, setNewTopic] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [breakdown, setBreakdown] = useState({});

  function addSubject() {
    if (!newSubject.trim()) return;
    const s = { id: Date.now(), name: newSubject.trim(), topics: [] };
    setSubjects((prev) => [...prev, s]);
    setNewSubject("");
    setSelected(s.id);
  }

  function addTopic(subjectId) {
    if (!newTopic.trim()) return;
    setSubjects((prev) =>
      prev.map((s) =>
        s.id === subjectId ? { ...s, topics: [...s.topics, { id: Date.now(), text: newTopic.trim(), done: false }] } : s
      )
    );
    setNewTopic("");
  }

  function toggleTopic(subjectId, topicId) {
    setSubjects((prev) =>
      prev.map((s) =>
        s.id === subjectId ? { ...s, topics: s.topics.map((t) => (t.id === topicId ? { ...t, done: !t.done } : t)) } : s
      )
    );
  }

  function removeSubject(id) {
    setSubjects((prev) => prev.filter((s) => s.id !== id));
    if (selected === id) setSelected(null);
  }

  async function generateBreakdown(subject) {
    if (breakdown[subject.id]) return;
    setAiLoading(subject.id);
    try {
      const system = `You are a study planning assistant. Given a subject, generate 6-8 key topics a student should study. Keep names simple. Return ONLY a JSON array of strings, no markdown. Example: ["Topic 1", "Topic 2"]`;
      const text = await callClaude([{ role: "user", content: `Subject: ${subject.name}` }], system, 400);
      const clean = text.replace(/```json|```/g, "").trim();
      const topics = JSON.parse(clean);
      setBreakdown((prev) => ({ ...prev, [subject.id]: topics }));
    } catch (e) {
      setBreakdown((prev) => ({ ...prev, [subject.id]: ["Error generating topics"] }));
    }
    setAiLoading(false);
  }

  function addSuggestedTopic(subjectId, text) {
    setSubjects((prev) =>
      prev.map((s) =>
        s.id === subjectId ? { ...s, topics: [...s.topics, { id: Date.now(), text, done: false }] } : s
      )
    );
  }

  const selectedSubject = subjects.find((s) => s.id === selected);

  return (
    <div style={{ display: "flex", gap: "1.5rem", height: "100%" }}>
      <div style={{ width: "220px", flexShrink: 0 }}>
        <div style={{ fontFamily: sansFont, fontSize: "0.75rem", color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.75rem" }}>Subjects</div>
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
          <input
            value={newSubject}
            onChange={(e) => setNewSubject(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addSubject()}
            placeholder="Add subject..."
            style={{ ...inputStyle, flex: 1, padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}
          />
          <button onClick={addSubject} style={{ ...btnStyle(false), padding: "0.5rem 0.75rem", fontSize: "1rem" }}>+</button>
        </div>
        {subjects.map((s) => {
          const done = s.topics.filter((t) => t.done).length;
          const total = s.topics.length;
          const pct = total ? Math.round((done / total) * 100) : 0;
          return (
            <div
              key={s.id}
              onClick={() => setSelected(s.id)}
              style={{ padding: "0.75rem", borderRadius: "8px", marginBottom: "0.5rem", cursor: "pointer", background: selected === s.id ? COLORS.accent + "22" : COLORS.card, border: `1px solid ${selected === s.id ? COLORS.accent : COLORS.border}`, transition: "all 0.15s" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: sansFont, fontSize: "0.9rem", color: COLORS.text }}>{s.name}</span>
                <span onClick={(e) => { e.stopPropagation(); removeSubject(s.id); }} style={{ color: COLORS.red, fontSize: "0.8rem", cursor: "pointer" }}>✕</span>
              </div>
              {total > 0 && (
                <div style={{ marginTop: "0.4rem" }}>
                  <div style={{ height: "3px", background: COLORS.border, borderRadius: "2px" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: COLORS.green, borderRadius: "2px", transition: "width 0.3s" }} />
                  </div>
                  <div style={{ fontFamily: sansFont, fontSize: "0.72rem", color: COLORS.muted, marginTop: "0.25rem" }}>{done}/{total} done</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ flex: 1, background: COLORS.card, borderRadius: "12px", border: `1px solid ${COLORS.border}`, padding: "1.5rem", overflowY: "auto" }}>
        {!selectedSubject ? (
          <div style={{ textAlign: "center", paddingTop: "4rem", color: COLORS.muted }}>
            <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>🎓</div>
            <div style={{ fontFamily: systemFont, fontSize: "1.2rem" }}>Select or create a subject to start planning</div>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem" }}>
              <h2 style={{ fontFamily: systemFont, fontSize: "1.6rem", color: COLORS.accentLight, margin: 0 }}>{selectedSubject.name}</h2>
              <button onClick={() => generateBreakdown(selectedSubject)} disabled={!!aiLoading} style={{ ...btnStyle(!!aiLoading), padding: "0.4rem 0.9rem", fontSize: "0.8rem" }}>
                {aiLoading === selectedSubject.id ? "Generating..." : "✨ AI Suggest Topics"}
              </button>
            </div>
            {breakdown[selectedSubject.id] && (
              <div style={{ marginBottom: "1.25rem", padding: "1rem", background: COLORS.surface, borderRadius: "8px", border: `1px solid ${COLORS.accent}44` }}>
                <div style={{ fontFamily: sansFont, fontSize: "0.78rem", color: COLORS.accent, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.6rem" }}>AI Suggested Topics</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  {breakdown[selectedSubject.id].map((t, i) => (
                    <div
                      key={i}
                      onClick={() => addSuggestedTopic(selectedSubject.id, t)}
                      style={{ padding: "0.35rem 0.75rem", borderRadius: "20px", background: COLORS.accent + "22", border: `1px solid ${COLORS.accent}55`, color: COLORS.accent, fontFamily: sansFont, fontSize: "0.82rem", cursor: "pointer" }}
                    >
                      + {t}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
              <input
                value={newTopic}
                onChange={(e) => setNewTopic(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addTopic(selectedSubject.id)}
                placeholder="Add a topic to study..."
                style={{ ...inputStyle, flex: 1, padding: "0.6rem 0.75rem" }}
              />
              <button onClick={() => addTopic(selectedSubject.id)} style={{ ...btnStyle(false), padding: "0.6rem 1rem" }}>Add</button>
            </div>
            {selectedSubject.topics.length === 0 ? (
              <div style={{ color: COLORS.muted, fontFamily: sansFont, fontSize: "0.9rem", textAlign: "center", padding: "2rem" }}>
                No topics yet. Add one above or use AI suggestions.
              </div>
            ) : (
              selectedSubject.topics.map((t) => (
                <div
                  key={t.id}
                  onClick={() => toggleTopic(selectedSubject.id, t.id)}
                  style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem 1rem", borderRadius: "8px", marginBottom: "0.5rem", background: t.done ? COLORS.green + "11" : COLORS.surface, border: `1px solid ${t.done ? COLORS.green + "44" : COLORS.border}`, cursor: "pointer", transition: "all 0.15s" }}
                >
                  <div style={{ width: "20px", height: "20px", borderRadius: "50%", border: `2px solid ${t.done ? COLORS.green : COLORS.muted}`, background: t.done ? COLORS.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    {t.done && <span style={{ color: "#fff", fontSize: "0.7rem" }}>✓</span>}
                  </div>
                  <span style={{ fontFamily: sansFont, fontSize: "0.9rem", color: t.done ? COLORS.muted : COLORS.text, textDecoration: t.done ? "line-through" : "none" }}>
                    {t.text}
                  </span>
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ArabicTranslator({ onSendToNotes }) {
  const [input, setInput] = useState("");
  const [bookName, setBookName] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState("ar-en");
  const { library, addBook, removeBook } = useBookLibrary();
  const [selectedBookId, setSelectedBookId] = useState(null);

  const selectedBook = library.find((b) => b.id === selectedBookId) || null;

  function handleSelectBook(id) {
    setSelectedBookId(id);
    const book = library.find((b) => b.id === id);
    setBookName(book ? book.name : "");
  }

  async function translate() {
    if (!input.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      let bookContext = "";
      if (selectedBook) {
        const context = findSurroundingContext(selectedBook.text, input);
        if (context) {
          bookContext = `This passage is from the book "${selectedBook.name}". Below is the REAL surrounding text from the actual book, for context only — use it to correctly understand pronouns, references, and exact intended meaning, but translate only the passage the user actually pasted, not this whole context block:\n\n--- SURROUNDING CONTEXT FROM "${selectedBook.name}" ---\n${context}\n--- END CONTEXT ---`;
        } else {
          bookContext = `This text is from: "${selectedBook.name}". Use your knowledge of this source to inform the translation, subject detection, and source notes.`;
        }
      } else if (bookName.trim()) {
        bookContext = `This text is from: "${bookName.trim()}". Use your knowledge of this source to inform the translation, subject detection, and source notes.`;
      }

      const system = mode === "ar-en"
        ? `You are an expert translator of Classical Arabic texts and a study assistant for students of traditional Islamic sciences.

Your task is to help students understand texts from any subject, including but not limited to: Fiqh, Usul al-Fiqh, Nahw, Sarf, Balaghah, Aqidah, Tafsir, Hadith, Mantiq, Tajwid, Arabic Literature, Classical Poetry, Seerah, Islamic History, Uloom al-Quran, Uloom al-Hadith.

${bookContext}

GENERAL RULES:
1. Determine the likely subject of the text automatically.
2. Translate according to the conventions of that subject.
3. Stay close to the Arabic wording — do NOT excessively paraphrase.
4. Do NOT produce awkward machine-like English.
5. Do NOT turn the translation into a commentary.
6. Preserve important Arabic and technical terms in transliteration with a concise English meaning in parentheses immediately after. Examples: al-Mutah (enjoyment), an-Nikah (marriage), al-Ijab (offer), al-Qabul (acceptance), al-Fasiq (open sinner), adh-Dhimmi (protected non-Muslim).
7. Prefer the intended scholarly meaning over an incorrect dictionary meaning.
8. Assume the reader is a student studying a traditional text.

Respond ONLY with valid JSON in this exact format — no extra text, no markdown fences:
{
  "wordByWord": [{"arabic": "vowelled arabic word or phrase", "english": "meaning"}],
  "translation": "the full running translation as a single string",
  "explanation": "2-4 sentence beginner-friendly explanation in simple language",
  "terms": [{"arabic": "arabic term", "transliteration": "romanized", "meaning": "concise meaning"}],
  "irab": [{"word": "arabic word", "role": "grammatical role", "state": "grammatical state", "explanation": "short explanation"}],
  "studyTip": "one sentence on the main point a student should remember",
  "source": "Field: detected subject e.g. Hanafi Fiqh, Nahw, Balaghah",
  "formality": "classical"
}`
        : `You are an expert English-to-Arabic translator. Produce natural fluent Arabic. Respond ONLY with valid JSON: {"translation":"arabic text","transliteration":"romanized guide","notes":"any notes","formality":"formal or casual"}`;

      const text = await callClaude([{ role: "user", content: `Translate:\n\n${input}` }], system, 1600);
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setResult(parsed);
    } catch (e) {
      setResult({ translation: "Translation error. Please try again.", source: e.message, formality: "—" });
    }
    setLoading(false);
  }

  const SectionLabel = ({ children, color }) => (
    <div style={{ fontFamily: sansFont, fontSize: "0.72rem", color: color || COLORS.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "0.6rem", fontWeight: 600 }}>
      {children}
    </div>
  );

  const Card = ({ children, borderColor, bg }) => (
    <div style={{ marginBottom: "1rem", padding: "0.85rem 1rem", background: bg || COLORS.surface, borderRadius: "8px", border: `1px solid ${borderColor || COLORS.border}` }}>
      {children}
    </div>
  );

  return (
    <div style={{ maxWidth: "780px", margin: "0 auto", height: "100%", overflowY: "auto", paddingBottom: "2rem", boxSizing: "border-box" }}>
      {/* Mode toggle */}
      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.25rem", justifyContent: "center" }}>
        {[["ar-en", "العربية → English"], ["en-ar", "English → العربية"]].map(([v, label]) => (
          <button
            key={v}
            onClick={() => { setMode(v); setResult(null); setInput(""); }}
            style={{ padding: "0.5rem 1.25rem", borderRadius: "20px", border: `1.5px solid ${mode === v ? COLORS.accent : COLORS.border}`, background: mode === v ? COLORS.accent + "22" : COLORS.card, color: mode === v ? COLORS.accent : COLORS.muted, fontFamily: sansFont, fontSize: "0.875rem", cursor: "pointer" }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Book library */}
      <div style={{ marginBottom: "0.75rem" }}>
        <BookLibraryPanel
          library={library}
          addBook={addBook}
          removeBook={removeBook}
          selectedBookId={selectedBookId}
          onSelectBook={handleSelectBook}
        />
      </div>

      {/* Book name */}
      <div style={{ marginBottom: "0.75rem" }}>
        <input
          value={bookName}
          onChange={(e) => { setBookName(e.target.value); setSelectedBookId(null); }}
          placeholder="Type a name, or select a book above"
          style={{ ...inputStyle, fontSize: "0.875rem" }}
        />
        {selectedBook && (
          <div style={{ fontFamily: sansFont, fontSize: "0.75rem", color: COLORS.green, marginTop: "0.3rem" }}>
            ✓ Reading from your uploaded PDF ({selectedBook.chars.toLocaleString()} chars)
          </div>
        )}
      </div>

      {/* Input area */}
      <div style={{ background: COLORS.card, borderRadius: "12px", border: `1px solid ${COLORS.border}`, overflow: "hidden" }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={mode === "ar-en" ? "أدخل النص العربي هنا..." : "Enter English text here..."}
          style={{ width: "100%", minHeight: "160px", background: "transparent", border: "none", outline: "none", padding: "1.25rem", fontFamily: mode === "ar-en" ? "'Noto Naskh Arabic', serif" : sansFont, fontSize: mode === "ar-en" ? "1.2rem" : "1rem", color: COLORS.text, resize: "vertical", direction: mode === "ar-en" ? "rtl" : "ltr", lineHeight: 1.8, boxSizing: "border-box" }}
        />
        <div style={{ borderTop: `1px solid ${COLORS.border}`, padding: "0.75rem 1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: sansFont, fontSize: "0.8rem", color: COLORS.muted }}>{input.length} chars</span>
          <button onClick={translate} disabled={loading || !input.trim()} style={btnStyle(loading || !input.trim())}>
            {loading ? "Translating..." : "Translate →"}
          </button>
        </div>
      </div>

      {loading && <div style={{ marginTop: "1.5rem" }}><LoadingDots label="Translating" /></div>}

      {result && !loading && (
        <div style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "0" }}>

          {/* ── WORD BY WORD ── */}
          {mode === "ar-en" && result.wordByWord && result.wordByWord.length > 0 && (
            <div style={{ background: COLORS.card, borderRadius: "12px 12px 0 0", border: `1px solid ${COLORS.border}`, borderBottom: "none", padding: "1.1rem 1.25rem" }}>
              <SectionLabel color={COLORS.accent}>Word by Word</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {result.wordByWord.map((w, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
                    <span style={{ fontFamily: "'Noto Naskh Arabic', serif", fontSize: "1.1rem", color: COLORS.accentLight, direction: "rtl", minWidth: "120px", textAlign: "right" }}>{w.arabic}</span>
                    <span style={{ color: COLORS.muted, fontSize: "0.85rem" }}>—</span>
                    <span style={{ fontFamily: sansFont, fontSize: "0.88rem", color: COLORS.text }}>{w.english}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── MAIN TRANSLATION ── */}
          <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderTop: result.wordByWord ? `1px solid ${COLORS.border}` : undefined, borderRadius: result.wordByWord ? "0" : "12px 12px 0 0", padding: "1.1rem 1.25rem", borderBottom: "none" }}>
            <SectionLabel color={COLORS.blue}>Translation</SectionLabel>
            {mode === "ar-en" ? (
              <p style={{ fontFamily: systemFont, fontSize: "1.1rem", color: COLORS.text, lineHeight: 1.85, margin: 0 }}>
                {result.translation}
              </p>
            ) : (
              <p style={{ fontFamily: "'Noto Naskh Arabic', serif", fontSize: "1.3rem", color: COLORS.text, lineHeight: 1.85, margin: 0, direction: "rtl" }}>
                {result.translation}
              </p>
            )}
          </div>

          {/* ── SIMPLE EXPLANATION ── */}
          {result.explanation && (
            <div style={{ background: COLORS.green + "0f", border: `1px solid ${COLORS.border}`, borderTop: `1px solid ${COLORS.green}22`, padding: "1rem 1.25rem", borderBottom: "none" }}>
              <SectionLabel color={COLORS.green}>Simple Explanation</SectionLabel>
              <p style={{ fontFamily: sansFont, fontSize: "0.88rem", color: COLORS.text, margin: 0, lineHeight: 1.7 }}>{result.explanation}</p>
            </div>
          )}

          {/* ── KEY TERMS ── */}
          {result.terms && result.terms.length > 0 && (
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderTop: `1px solid ${COLORS.blue}22`, padding: "1rem 1.25rem", borderBottom: "none" }}>
              <SectionLabel color={COLORS.blue}>Key Terms</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                {result.terms.map((t, i) => (
                  <div key={i} style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", flexWrap: "wrap" }}>
                    {t.arabic && <span style={{ fontFamily: "'Noto Naskh Arabic', serif", fontSize: "1rem", color: COLORS.accentLight }}>{t.arabic}</span>}
                    {t.arabic && <span style={{ color: COLORS.muted, fontSize: "0.8rem" }}>·</span>}
                    <span style={{ fontFamily: monoFont, fontSize: "0.83rem", color: COLORS.accent }}>{t.transliteration}</span>
                    <span style={{ color: COLORS.muted, fontSize: "0.83rem" }}>—</span>
                    <span style={{ fontFamily: sansFont, fontSize: "0.83rem", color: COLORS.muted }}>{t.meaning}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── I'RAB HIGHLIGHTS ── */}
          {mode === "ar-en" && result.irab && result.irab.length > 0 && (
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, borderTop: `1px solid ${COLORS.border}`, padding: "1rem 1.25rem", borderBottom: "none" }}>
              <SectionLabel color="#c896d8">I'rab Highlights</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {result.irab.map((r, i) => (
                  <div key={i} style={{ fontFamily: sansFont, fontSize: "0.85rem", color: COLORS.text, lineHeight: 1.6 }}>
                    <span style={{ fontFamily: "'Noto Naskh Arabic', serif", fontSize: "1rem", color: COLORS.accentLight }}>{r.word}</span>
                    <span style={{ color: COLORS.muted }}> — {r.role}{r.state ? `, therefore ${r.state}` : ""}. </span>
                    {r.explanation && <span style={{ color: COLORS.muted, fontSize: "0.82rem" }}>{r.explanation}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── STUDY TIP + SOURCE ── */}
          <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderTop: `1px solid ${COLORS.accent}22`, borderRadius: "0 0 12px 12px", padding: "1rem 1.25rem" }}>
            {result.studyTip && (
              <div style={{ marginBottom: result.source ? "0.75rem" : 0 }}>
                <SectionLabel color={COLORS.accent}>Study Tip</SectionLabel>
                <p style={{ fontFamily: sansFont, fontSize: "0.875rem", color: COLORS.text, margin: 0, lineHeight: 1.6 }}>💡 {result.studyTip}</p>
              </div>
            )}
            {result.source && (
              <div>
                <SectionLabel>Source</SectionLabel>
                <p style={{ fontFamily: monoFont, fontSize: "0.82rem", color: COLORS.muted, margin: 0 }}>{result.source}</p>
              </div>
            )}
            {/* Actions */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "1rem", paddingTop: "0.75rem", borderTop: `1px solid ${COLORS.border}` }}>
              <button
                onClick={() => onSendToNotes(result.translation || "", bookName)}
                style={{ fontFamily: sansFont, fontSize: "0.85rem", color: COLORS.green, background: COLORS.green + "11", border: `1px solid ${COLORS.green}44`, borderRadius: "8px", padding: "0.4rem 0.9rem", cursor: "pointer" }}
              >
                📝 Send to Research Notes
              </button>
              <button
                onClick={() => {
                  const txt = result.wordByWord
                    ? result.wordByWord.map(w => `${w.arabic} — ${w.english}`).join("\n") + "\n\n" + result.translation
                    : result.translation;
                  navigator.clipboard.writeText(txt);
                }}
                style={{ fontFamily: sansFont, fontSize: "0.8rem", color: COLORS.muted, background: "none", border: "none", cursor: "pointer" }}
              >
                📋 Copy
              </button>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}

function LoadingDots({ label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", justifyContent: "center", padding: "3rem" }}>
      <div style={{ display: "flex", gap: "6px" }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ width: "8px", height: "8px", borderRadius: "50%", background: COLORS.accent, animation: "pulse 1.2s ease-in-out infinite", animationDelay: `${i * 0.2}s` }} />
        ))}
      </div>
      <span style={{ fontFamily: sansFont, fontSize: "0.9rem", color: COLORS.muted }}>{label}...</span>
    </div>
  );
}

const inputStyle = {
  width: "100%", background: COLORS.surface, border: `1px solid ${COLORS.border}`,
  borderRadius: "8px", padding: "0.65rem 0.85rem", color: COLORS.text,
  fontFamily: sansFont, fontSize: "0.9rem", outline: "none", boxSizing: "border-box",
};

const labelStyle = {
  display: "block", fontFamily: sansFont, fontSize: "0.78rem", color: COLORS.muted,
  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.4rem",
};

const btnStyle = (disabled) => ({
  background: disabled ? COLORS.border : COLORS.accent,
  color: disabled ? COLORS.muted : "#0f0e17",
  border: "none", borderRadius: "8px", padding: "0.65rem 1.25rem",
  fontFamily: sansFont, fontSize: "0.875rem", fontWeight: "600",
  cursor: disabled ? "not-allowed" : "pointer", transition: "all 0.15s",
  whiteSpace: "nowrap",
});

export default function App() {
  const [activeTab, setActiveTab] = useState(0);
  const [notesPrefill, setNotesPrefill] = useState("");
  const [topicPrefill, setTopicPrefill] = useState("");
  const [bookPrefill, setBookPrefill] = useState("");

  function handleSendToNotes(translation, bookName) {
    setNotesPrefill(translation);
    setTopicPrefill("Translated from Arabic");
    setBookPrefill(bookName || "");
    setActiveTab(0);
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,600;1,400&family=DM+Sans:wght@400;500;600&family=DM+Mono&family=Noto+Naskh+Arabic:wght@400;600&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; background: ${COLORS.bg}; }
        textarea, input { color-scheme: dark; }
        textarea::placeholder, input::placeholder { color: ${COLORS.muted}; }
        @keyframes pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${COLORS.bg}; }
        ::-webkit-scrollbar-thumb { background: ${COLORS.border}; border-radius: 3px; }
      `}</style>
      <div style={{ minHeight: "100vh", background: COLORS.bg, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "1.5rem 2rem 0", borderBottom: `1px solid ${COLORS.border}` }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", marginBottom: "1.25rem" }}>
            <h1 style={{ fontFamily: systemFont, fontSize: "1.8rem", color: COLORS.accentLight, margin: 0, fontWeight: 400 }}>Scholar Suite</h1>
            <span style={{ fontFamily: sansFont, fontSize: "0.8rem", color: COLORS.muted }}>Research · Study · Translate</span>
          </div>
          <div style={{ display: "flex" }}>
            {TABS.map((tab, i) => (
              <button
                key={i}
                onClick={() => setActiveTab(i)}
                style={{ padding: "0.65rem 1.5rem", background: "none", border: "none", borderBottom: `2px solid ${activeTab === i ? COLORS.accent : "transparent"}`, color: activeTab === i ? COLORS.accent : COLORS.muted, fontFamily: sansFont, fontSize: "0.9rem", fontWeight: activeTab === i ? "600" : "400", cursor: "pointer", transition: "all 0.15s" }}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, padding: "1.5rem 2rem", overflow: "hidden" }}>
          <div style={{ height: "calc(100vh - 160px)" }}>
            {activeTab === 0 && <ResearchAssistant prefillNotes={notesPrefill} prefillTopic={topicPrefill} prefillBook={bookPrefill} />}
            {activeTab === 1 && <StudyPlanner />}
            {activeTab === 2 && <ArabicTranslator onSendToNotes={handleSendToNotes} />}
          </div>
        </div>
      </div>
    </>
  );
}
