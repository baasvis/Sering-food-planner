/* Voice Notes PWA — capture voice (on-device Google speech recognition via the
 * Web Speech API) or typed notes and POST them to the server. */

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const transcriptEl = $("transcript");
const textbox = $("textbox");
const recbtn = $("recbtn");
const savebtn = $("savebtn");
const discardbtn = $("discardbtn");
const modebtn = $("modebtn");
const langbtn = $("langbtn");
const notesEl = $("notes");
const toastEl = $("toast");

// --- key handling: /?key=SECRET once, then stored locally -------------------
const params = new URLSearchParams(location.search);
if (params.get("key")) {
  localStorage.setItem("notes_key", params.get("key"));
  history.replaceState(null, "", location.pathname);
}
const KEY = () => localStorage.getItem("notes_key") || "";

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY()}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    setStatus("Not authorized — open this app once via /?key=YOUR_SECRET");
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 1600);
}

// --- language toggle ---------------------------------------------------------
const LANGS = ["nl-NL", "en-US"];
let lang = localStorage.getItem("notes_lang") || LANGS[0];
function renderLang() {
  langbtn.textContent = lang.startsWith("nl") ? "NL" : "EN";
}
langbtn.addEventListener("click", () => {
  lang = LANGS[(LANGS.indexOf(lang) + 1) % LANGS.length];
  localStorage.setItem("notes_lang", lang);
  renderLang();
  if (recording) {
    stopRecognition();
    startRecognition();
  }
});
renderLang();

// --- voice capture (Web Speech API) ------------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recording = false;
let finalText = "";
let interimText = "";

function renderTranscript() {
  if (!finalText && !interimText) {
    transcriptEl.innerHTML = '<span class="interim">Tap the mic and start talking…</span>';
    return;
  }
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  transcriptEl.innerHTML =
    esc(finalText) + (interimText ? ` <span class="interim">${esc(interimText)}</span>` : "");
  savebtn.disabled = !finalText.trim();
  discardbtn.disabled = !finalText.trim() && !recording;
}

function startRecognition() {
  recognition = new SR();
  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (e) => {
    interimText = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript + " ";
      else interimText += r[0].transcript;
    }
    renderTranscript();
  };
  recognition.onerror = (e) => {
    if (e.error === "not-allowed") {
      recording = false;
      updateRecUi();
      setStatus("Microphone blocked — allow mic access for this app in site settings.");
    }
    // "no-speech" and "aborted" are routine; onend handles the restart.
  };
  recognition.onend = () => {
    // Chrome on Android stops after pauses — keep listening until the user stops.
    if (recording) {
      try {
        recognition.start();
      } catch {
        /* already starting */
      }
    }
  };
  recognition.start();
}

function stopRecognition() {
  if (recognition) {
    recognition.onend = null;
    recognition.stop();
    recognition = null;
  }
}

function updateRecUi() {
  recbtn.classList.toggle("recording", recording);
  recbtn.textContent = recording ? "⏹️" : "🎙️";
  setStatus(recording ? `Listening (${lang})… tap ⏹ to stop & save` : "");
  discardbtn.disabled = !recording && !finalText.trim();
}

async function toggleRecording() {
  if (!SR) {
    setStatus("Speech recognition not supported in this browser — use ⌨️ text mode.");
    return;
  }
  if (recording) {
    recording = false;
    stopRecognition();
    updateRecUi();
    interimText = "";
    renderTranscript();
    if (finalText.trim()) await saveNote(finalText.trim(), "voice");
  } else {
    setTextMode(false);
    recording = true;
    finalText = "";
    interimText = "";
    renderTranscript();
    updateRecUi();
    try {
      startRecognition();
    } catch {
      recording = false;
      updateRecUi();
      setStatus("Could not start the microphone — tap the mic to try again.");
    }
  }
}
recbtn.addEventListener("click", toggleRecording);

discardbtn.addEventListener("click", () => {
  recording = false;
  stopRecognition();
  finalText = "";
  interimText = "";
  renderTranscript();
  updateRecUi();
  setStatus("Discarded");
});

// --- text mode ----------------------------------------------------------------
let textMode = false;
function setTextMode(on) {
  textMode = on;
  textbox.style.display = on ? "block" : "none";
  transcriptEl.style.display = on ? "none" : "block";
  modebtn.textContent = on ? "🎙️" : "⌨️";
  savebtn.disabled = on ? !textbox.value.trim() : !finalText.trim();
  if (on && recording) {
    recording = false;
    stopRecognition();
    updateRecUi();
  }
}
modebtn.addEventListener("click", () => setTextMode(!textMode));
textbox.addEventListener("input", () => {
  savebtn.disabled = !textbox.value.trim();
});

savebtn.addEventListener("click", async () => {
  if (textMode) {
    const text = textbox.value.trim();
    if (!text) return;
    await saveNote(text, sharedNote ? "shared" : "text");
    textbox.value = "";
    savebtn.disabled = true;
    sharedNote = false;
  } else if (finalText.trim()) {
    await saveNote(finalText.trim(), "voice");
  }
});

// --- saving (with offline queue) ------------------------------------------------
function queuePending(note) {
  const q = JSON.parse(localStorage.getItem("pending_notes") || "[]");
  q.push(note);
  localStorage.setItem("pending_notes", JSON.stringify(q));
}

async function flushPending() {
  const q = JSON.parse(localStorage.getItem("pending_notes") || "[]");
  if (q.length === 0) return;
  const remaining = [];
  for (const note of q) {
    try {
      await api("/api/notes", { method: "POST", body: JSON.stringify(note) });
    } catch {
      remaining.push(note);
    }
  }
  localStorage.setItem("pending_notes", JSON.stringify(remaining));
  if (remaining.length < q.length) toast("Synced queued notes ✓");
}

async function saveNote(text, kind) {
  const note = { text, kind, lang, source: "pwa" };
  try {
    await api("/api/notes", { method: "POST", body: JSON.stringify(note) });
    toast("Saved ✓");
  } catch (e) {
    if (e.message !== "unauthorized") {
      queuePending(note);
      toast("Offline — queued");
    }
  }
  finalText = "";
  interimText = "";
  renderTranscript();
  savebtn.disabled = true;
  loadNotes().catch(() => {});
}

// --- inbox list -----------------------------------------------------------------
async function loadNotes() {
  const { notes } = await api("/api/notes?status=inbox&limit=15");
  notesEl.innerHTML = "";
  for (const n of notes) {
    const li = document.createElement("li");
    const body = document.createElement("div");
    body.className = "body";
    const textDiv = document.createElement("div");
    textDiv.textContent = n.text;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${n.kind} · ${new Date(n.createdAt).toLocaleString()}`;
    body.append(textDiv, meta);
    const done = document.createElement("button");
    done.textContent = "✓";
    done.title = "Mark processed";
    done.addEventListener("click", async () => {
      await api(`/api/notes/${n.id}/processed`, { method: "POST" });
      loadNotes().catch(() => {});
    });
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Delete";
    del.addEventListener("click", async () => {
      await api(`/api/notes/${n.id}`, { method: "DELETE" });
      loadNotes().catch(() => {});
    });
    li.append(body, done, del);
    notesEl.appendChild(li);
  }
}

// --- boot --------------------------------------------------------------------------
let sharedNote = false;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// Web Share Target: text shared from other apps (e.g. Pixel Recorder transcripts)
const sharedText = [params.get("title"), params.get("text"), params.get("url")]
  .filter(Boolean)
  .join("\n");
if (sharedText) {
  sharedNote = true;
  setTextMode(true);
  textbox.value = sharedText;
  savebtn.disabled = false;
  setStatus("Shared text — tap ✓ to save");
  history.replaceState(null, "", location.pathname);
} else if (params.get("autostart") === "1" && SR) {
  // Opened via Quick Tap / launcher icon: start listening immediately.
  toggleRecording();
}

flushPending().catch(() => {});
loadNotes().catch(() => {});
window.addEventListener("online", () => flushPending().catch(() => {}));
