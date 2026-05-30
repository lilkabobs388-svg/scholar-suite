import { useState } from "react";

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

async function callClaude(messages, systemPrompt) {
  const body = {
    model: "llama-3.3-70b-versatile",
    max_tokens: 1000,
    system: systemPrompt,
    messages,
  };

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// ─── RESEARCH ASSISTANT ───────────────────────────────────────────────────────

function ResearchAssistant({ prefillNotes, prefillTopic }) {
  const [topic, setTopic] = useState(prefillTopic || "");
  const [notes, setNotes] = useState(prefillNotes || "");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);

  async function research() {
    if (!topic.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const system = `You are a friendly study assistant who explains things simply and clearly. Your job is to help students understand topics easily.

When given a topic and optional notes:
1. Use plain, everyday English — avoid jargon and technical terms unless necessary
2. If you must use a technical term, immediately explain it in simple words
3. Fill in any gaps in the student's notes with easy-to-understand explanations
4. Organize everything with clear headers and short bullet points
5. Write like you're explaining to a friend, not writing an academic paper
6. Keep sentences short and clear
7. Use examples and analogies to make things click

Format with ## headers, bullet points starting with -, and **bold** for key terms.`;

      const userMsg = notes.trim()
        ? `Topic: ${topic}\n\nMy notes so far:\n${notes}\n\nPlease help me understand this topic better. Use my notes as a starting point, fill in what's missing, and explain everything in simple, easy-to-understand language.`
        : `Topic: ${topic}\n\nPlease explain this topic to me in simple, easy-to-understand language. Give me a clear overview I can actually use for studying.`;

      const text = await callClaude([{ role: "user", content: userMsg }], system);
      setResult(text);
      setHistory((h) => [{ topic, result: text }, ...h.slice(0, 4)]);
    } catch (e) {
      setResult("Error: " + e.message);
    }
    setLoading(false);
  }

  function renderResult(text) {
    const lines = text.split("\n");
    return lines.map((line, i) => {
      if (line.startsWith("## ")) return <h3 key={i} style={{ color: COLORS.accent, fontFamily: systemFont, fontSize: "1.2rem", margin: "1.2rem 0 0.4rem", borderBottom: `1px solid ${COLORS.border}`, paddingBottom: "0.3rem" }}>{line.slice(3)}</h3>;
      if (line.startsWith("# ")) return <h2 key={i} style={{ color: COLORS.accentLight, fontFamily: systemFont, fontSize: "1.4rem", margin: "1rem 0 0.5rem" }}>{line.slice(2)}</h2>;
      if (line.startsWith("- ") || line.startsWith("• ")) return <div key={i} style={{ display: "flex", gap: "0.5rem", margin: "0.25rem 0", paddingLeft: "0.5rem" }}><span style={{ color: COLORS.accent }}>▸</span><span style={{ fontFamily: sansFont, fontSize: "0.9rem", color: COLORS.text, lineHeight: 1.6 }}>{formatBold(line.slice(2))}</span></div>;
      if (line.trim() === "") return <div key={i} style={{ height: "0.5rem" }} />;
      return <p key={i} style={{ fontFamily: sansFont, fontSize: "0.9rem", color: COLORS.text, lineHeight: 1.7, margin: "0.2rem 0" }}>{formatBold(line)}</p>;
    });
  }

  function formatBold(text) {
    const parts = text.split(/\*\*(.*?)\*\*/g);
    return parts.map((p, i) => i % 2 === 1 ? <strong key={i} style={{ color: COLORS.accentLight }}>{p}</strong> : p);
  }

  return (
    <div style={{ display: "flex", gap: "1.5rem", height: "100%" }}>
      <div style={{ width: "320px", flexShrink: 0, display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div>
          <label style={labelStyle}>Research Topic</label>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === "Enter" && research()} placeholder="e.g. Quantum entanglement, Ottoman history..." style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Your Notes (optional)</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Paste or write any notes you already have..." style={{ ...inputStyle, height: "140px", resize: "vertical" }} />
        </div>
        <button onClick={research} disabled={loading || !topic.trim()} style={btnStyle(loading || !topic.trim())}>
          {loading ? "Researching..." : "Research →"}
        </button>
        {history.length > 0 && (
          <div style={{ marginTop: "0.5rem" }}>
            <div style={{ fontFamily: sansFont, fontSize: "0.75rem", color: COLORS.muted, marginBottom: "0.5rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Recent</div>
            {history.map((h, i) => (
              <div key={i} onClick={() => { setTopic(h.topic); setResult(h.result); }} style={{ padding: "0.5rem 0.75rem", borderRadius: "6px", background: COLORS.card, marginBottom: "0.4rem", cursor: "pointer", border: `1px solid ${COLORS.border}` }}>
                <div style={{ fontFamily: sansFont, fontSize: "0.85rem", color: COLORS.text }}>{h.topic}</div>
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
          </div>
        )}
        {!loading && result && renderResult(result)}
      </div>
    </div>
  );
}

// ─── STUDY PLANNER ────────────────────────────────────────────────────────────

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
    setSubjects((prev) => prev.map((s) => s.id === subjectId ? { ...s, topics: [...s.topics, { id: Date.now(), text: newTopic.trim(), done: false }] } : s));
    setNewTopic("");
  }

  function toggleTopic(subjectId, topicId) {
    setSubjects((prev) => prev.map((s) => s.id === subjectId ? { ...s, topics: s.topics.map((t) => t.id === topicId ? { ...t, done: !t.done } : t) } : s));
  }

  function removeSubject(id) {
    setSubjects((prev) => prev.filter((s) => s.id !== id));
    if (selected === id) setSelected(null);
  }

  async function generateBreakdown(subject) {
    if (breakdown[subject.id]) return;
    setAiLoading(subject.id);
    try {
      const system = `You are a study planning assistant. Given a subject, generate a clear, practical list of 6-8 key topics a student should study to master it. Keep topic names simple and easy to understand. Return ONLY a JSON array of strings, no other text, no markdown fences. Example: ["Topic 1", "Topic 2"]`;
      const text = await callClaude([{ role: "user", content: `Subject: ${subject.name}` }], system);
      const clean = text.replace(/```json|```/g, "").trim();
      const topics = JSON.parse(clean);
      setBreakdown((prev) => ({ ...prev, [subject.id]: topics }));
    } catch (e) {
      setBreakdown((prev) => ({ ...prev, [subject.id]: ["Error generating topics"] }));
    }
    setAiLoading(false);
  }

  function addSuggestedTopic(subjectId, text) {
    setSubjects((prev) => prev.map((s) => s.id === subjectId ? { ...s, topics: [...s.topics, { id: Date.now(), text, done: false }] } : s));
  }

  const selectedSubject = subjects.find((s) => s.id === selected);

  return (
    <div style={{ display: "flex", gap: "1.5rem", height: "100%" }}>
      <div style={{ width: "220px", flexShrink: 0 }}>
        <div style={{ fontFamily: sansFont, fontSize: "0.75rem", color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.75rem" }}>Subjects</div>
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
          <input value={newSubject} onChange={(e) => setNewSubject(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addSubject()} placeholder="Add subject..." style={{ ...inputStyle, flex: 1, padding: "0.5rem 0.75rem", fontSize: "0.85rem" }} />
          <button onClick={addSubject} style={{ ...btnStyle(false), padding: "0.5rem 0.75rem", fontSize: "1rem" }}>+</button>
        </div>
        {subjects.map((s) => {
          const done = s.topics.filter((t) => t.done).length;
          const total = s.topics.length;
          const pct = total ? Math.round((done / total) * 100) : 0;
          return (
            <div key={s.id} onClick={() => setSelected(s.id)} style={{ padding: "0.75rem", borderRadius: "8px", marginBottom: "0.5rem", cursor: "pointer", background: selected === s.id ? COLORS.accent + "22" : COLORS.card, border: `1px solid ${selected === s.id ? COLORS.accent : COLORS.border}`, transition: "all 0.15s" }}>
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
                    <div key={i} onClick={() => addSuggestedTopic(selectedSubject.id, t)} style={{ padding: "0.35rem 0.75rem", borderRadius: "20px", background: COLORS.accent + "22", border: `1px solid ${COLORS.accent}55`, color: COLORS.accent, fontFamily: sansFont, fontSize: "0.82rem", cursor: "pointer" }}>
                      + {t}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
              <input value={newTopic} onChange={(e) => setNewTopic(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTopic(selectedSubject.id)} placeholder="Add a topic to study..." style={{ ...inputStyle, flex: 1, padding: "0.6rem 0.75rem" }} />
              <button onClick={() => addTopic(selectedSubject.id)} style={{ ...btnStyle(false), padding: "0.6rem 1rem" }}>Add</button>
            </div>
            {selectedSubject.topics.length === 0 ? (
              <div style={{ color: COLORS.muted, fontFamily: sansFont, fontSize: "0.9rem", textAlign: "center", padding: "2rem" }}>No topics yet. Add one above or use AI suggestions.</div>
            ) : (
              selectedSubject.topics.map((t) => (
                <div key={t.id} onClick={() => toggleTopic(selectedSubject.id, t.id)} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem 1rem", borderRadius: "8px", marginBottom: "0.5rem", background: t.done ? COLORS.green + "11" : COLORS.surface, border: `1px solid ${t.done ? COLORS.green + "44" : COLORS.border}`, cursor: "pointer", transition: "all 0.15s" }}>
                  <div style={{ width: "20px", height: "20px", borderRadius: "50%", border: `2px solid ${t.done ? COLORS.green : COLORS.muted}`, background: t.done ? COLORS.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    {t.done && <span style={{ color: "#fff", fontSize: "0.7rem" }}>✓</span>}
                  </div>
                  <span style={{ fontFamily: sansFont, fontSize: "0.9rem", color: t.done ? COLORS.muted : COLORS.text, textDecoration: t.done ? "line-through" : "none" }}>{t.text}</span>
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── ARABIC TRANSLATOR ────────────────────────────────────────────────────────

function ArabicTranslator({ onSendToNotes }) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState("ar-en");

  async function translate() {
    if (!input.trim()) return;
    setLoading(true);
    setResult(null);
    const isArToEn = mode === "ar-en";
    try {
      const system = isArToEn
        ? `You are an expert Arabic-to-English translator with deep knowledge of Modern Standard Arabic, Classical Arabic, Quranic Arabic, Islamic scholarship texts, Arabic morphology (sarf), syntax (nahw), and various Arabic dialects.

Your translations follow these rules:
1. NEVER force-translate proper nouns, technical terms, names of concepts, or specialized terminology — instead keep them transliterated (e.g. "Ẓanna", "Anna wa akhawātuha", "mubtada", "khabar") and explain them in brackets
2. Read the context carefully — if a word is being used as a technical term in grammar, jurisprudence, theology, or any field, treat it as a term not a regular word
3. Produce natural, fluent English that captures the meaning and tone — not word-for-word literal translation
4. For classical or scholarly texts, preserve the register and formality
5. For casual text, translate naturally and conversationally

Format your response as JSON:
{
  "translation": "the natural English translation with transliterated terms kept as-is",
  "terms": [{"term": "original term", "transliteration": "romanized", "meaning": "simple explanation"}],
  "notes": "any important context about the text type, style, or tricky parts (keep brief)",
  "formality": "formal / casual / religious / classical / technical"
}`
        : `You are an expert English-to-Arabic translator. Produce natural, fluent Arabic. Format as JSON:
{
  "translation": "the Arabic translation",
  "transliteration": "romanized pronunciation guide",
  "notes": "any notes on word choices",
  "formality": "formal / casual"
}`;

      const text = await callClaude([{ role: "user", content: `Translate the following:\n\n${input}` }], system);
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setResult(parsed);
    } catch (e) {
      setResult({ translation: "Translation error. Please try again.", notes: e.message, formality: "—" });
    }
    setLoading(false);
  }

  const formalityColor = { formal: COLORS.blue, casual: COLORS.green, religious: COLORS.accent, poetic: "#d88fd8", classical: "#c896d8", technical: COLORS.blue };

  return (
    <div style={{ maxWidth: "780px", margin: "0 auto" }}>
      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.25rem", justifyContent: "center" }}>
        {[["ar-en", "العربية → English"], ["en-ar", "English → العربية"]].map(([v, label]) => (
          <button key={v} onClick={() => { setMode(v); setResult(null); setInput(""); }} style={{ padding: "0.5rem 1.25rem", borderRadius: "20px", border: `1.5px solid ${mode === v ? COLORS.accent : COLORS.border}`, background: mode === v ? COLORS.accent + "22" : COLORS.card, color: mode === v ? COLORS.accent : COLORS.muted, fontFamily: sansFont, fontSize: "0.875rem", cursor: "pointer", transition: "all 0.15s" }}>
            {label}
          </button>
        ))}
      </div>
      <div style={{ background: COLORS.card, borderRadius: "12px", border: `1px solid ${COLORS.border}`, overflow: "hidden" }}>
        <textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder={mode === "ar-en" ? "أدخل النص العربي هنا..." : "Enter English text here..."} style={{ width: "100%", minHeight: "160px", background: "transparent", border: "none", outline: "none", padding: "1.25rem", fontFamily: mode === "ar-en" ? "'Noto Naskh Arabic', serif" : sansFont, fontSize: mode === "ar-en" ? "1.2rem" : "1rem", color: COLORS.text, resize: "vertical", direction: mode === "ar-en" ? "rtl" : "ltr", lineHeight: 1.8, boxSizing: "border-box" }} />
        <div style={{ borderTop: `1px solid ${COLORS.border}`, padding: "0.75rem 1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: sansFont, fontSize: "0.8rem", color: COLORS.muted }}>{input.length} chars</span>
          <button onClick={translate} disabled={loading || !input.trim()} style={btnStyle(loading || !input.trim())}>
            {loading ? "Translating..." : "Translate →"}
          </button>
        </div>
      </div>
      {loading && <div style={{ marginTop: "1.5rem" }}><LoadingDots label="Translating" /></div>}
      {result && !loading && (
        <div style={{ marginTop: "1.5rem", background: COLORS.card, borderRadius: "12px", border: `1px solid ${COLORS.border}`, overflow: "hidden" }}>
          <div style={{ padding: "0.75rem 1.25rem", background: COLORS.surface, borderBottom: `1px solid ${COLORS.border}`, display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <span style={{ fontFamily: sansFont, fontSize: "0.78rem", color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Translation</span>
            {result.formality && (
              <span style={{ padding: "0.2rem 0.6rem", borderRadius: "12px", background: (formalityColor[result.formality] || COLORS.muted) + "22", color: formalityColor[result.formality] || COLORS.muted, fontFamily: sansFont, fontSize: "0.75rem" }}>
                {result.formality}
              </span>
            )}
          </div>
          <div style={{ padding: "1.25rem" }}>
            <p style={{ fontFamily: mode === "en-ar" ? "'Noto Naskh Arabic', serif" : systemFont, fontSize: mode === "en-ar" ? "1.3rem" : "1.15rem", color: COLORS.text, lineHeight: 1.8, margin: "0 0 1rem", direction: mode === "en-ar" ? "rtl" : "ltr" }}>
              {result.translation}
            </p>
            {result.terms && result.terms.length > 0 && (
              <div style={{ marginBottom: "1rem", padding: "0.75rem 1rem", background: COLORS.surface, borderRadius: "8px", border: `1px solid ${COLORS.blue}33` }}>
                <div style={{ fontFamily: sansFont, fontSize: "0.78rem", color: COLORS.blue, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.6rem" }}>Key Terms</div>
                {result.terms.map((t, i) => (
                  <div key={i} style={{ marginBottom: "0.4rem" }}>
                    <span style={{ fontFamily: monoFont, fontSize: "0.85rem", color: COLORS.accent }}>{t.transliteration}</span>
                    <span style={{ fontFamily: sansFont, fontSize: "0.85rem", color: COLORS.muted }}> — {t.meaning}</span>
                  </div>
                ))}
              </div>
            )}
            {result.transliteration && (
              <p style={{ fontFamily: monoFont, fontSize: "0.9rem", color: COLORS.muted, margin: "0 0 0.75rem", borderTop: `1px solid ${COLORS.border}`, paddingTop: "0.75rem" }}>
                🔊 {result.transliteration}
              </p>
            )}
            {result.notes && (
              <div style={{ padding: "0.75rem 1rem", background: COLORS.accent + "11", borderRadius: "8px", borderLeft: `3px solid ${COLORS.accent}` }}>
                <span style={{ fontFamily: sansFont, fontSize: "0.78rem", color: COLORS.accent, textTransform: "uppercase", letterSpacing: "0.05em" }}>Translator's Note</span>
                <p style={{ fontFamily: sansFont, fontSize: "0.875rem", color: COLORS.text, margin: "0.4rem 0 0", lineHeight: 1.6 }}>{result.notes}</p>
              </div>
            )}
          </div>
          <div style={{ padding: "0.75rem 1.25rem", borderTop: `1px solid ${COLORS.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button onClick={() => onSendToNotes(result.translation, input)} style={{ fontFamily: sansFont, fontSize: "0.85rem", color: COLORS.green, background: COLORS.green + "11", border: `1px solid ${COLORS.green}44`, borderRadius: "8px", padding: "0.4rem 0.9rem", cursor: "pointer" }}>
              📝 Send to Research Notes
            </button>
            <button onClick={() => navigator.clipboard.writeText(result.translation)} style={{ fontFamily: sansFont, fontSize: "0.8rem", color: COLORS.muted, background: "none", border: "none", cursor: "pointer" }}>
              📋 Copy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SHARED ───────────────────────────────────────────────────────────────────

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

// ─── APP ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [activeTab, setActiveTab] = useState(0);
  const [notesPrefill, setNotesPrefill] = useState("");
  const [topicPrefill, setTopicPrefall] = useState("");

  function handleSendToNotes(translation, originalArabic) {
    setNotesPrefall("Translated from Arabic text");
    setNotesPrefall(translation);
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
          <div style={{ display: "flex", gap: "0" }}>
            {TABS.map((tab, i) => (
              <button key={i} onClick={() => setActiveTab(i)} style={{ padding: "0.65rem 1.5rem", background: "none", border: "none", borderBottom: `2px solid ${activeTab === i ? COLORS.accent : "transparent"}`, color: activeTab === i ? COLORS.accent : COLORS.muted, fontFamily: sansFont, fontSize: "0.9rem", fontWeight: activeTab === i ? "600" : "400", cursor: "pointer", transition: "all 0.15s" }}>
                {tab}
              </button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, padding: "1.5rem 2rem", overflow: "hidden" }}>
          <div style={{ height: "calc(100vh - 160px)" }}>
            {activeTab === 0 && <ResearchAssistant prefillNotes={notesPrefile} prefillTopic={topicPrefall} />}
            {activeTab === 1 && <StudyPlanner />}
            {activeTab === 2 && <ArabicTranslator onSendToNotes={handleSendToNotes} />}
          </div>
        </div>
      </div>
    </>
  );
}
