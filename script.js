// ==========================================================================
// AgriGraph AI — Multilingual & Voice Interactive Knowledge Engine
// ==========================================================================

// DOM Element References
const analyzeBtn = document.getElementById("analyzeBtn");
const problemText = document.getElementById("problemText");
const charCount = document.getElementById("charCount");
const clearBtn = document.getElementById("clearBtn");
const languageSelect = document.getElementById("languageSelect");
const micBtn = document.getElementById("micBtn");
const micBtnText = document.getElementById("micBtnText");
const voiceStatus = document.getElementById("voiceStatus");
const voiceStatusText = document.getElementById("voiceStatusText");

const errorBox = document.getElementById("errorBox");
const errorText = document.getElementById("errorText");
const errorRetryBtn = document.getElementById("errorRetryBtn");
const loading = document.getElementById("loading");
const loadingStepText = document.getElementById("loadingStepText");
const loadingProgress = document.getElementById("loadingProgress");
const results = document.getElementById("results");

const responseLangText = document.getElementById("responseLangText");
const copyAnswerBtn = document.getElementById("copyAnswerBtn");
const copyBtnText = document.getElementById("copyBtnText");
const ttsBtn = document.getElementById("ttsBtn");
const ttsBtnText = document.getElementById("ttsBtnText");

// Graph Elements & Controls
const nodeDetail = document.getElementById("nodeDetail");
const nodeDetailBody = document.getElementById("nodeDetailBody");
const closeDetailBtn = document.getElementById("closeDetailBtn");
const graphError = document.getElementById("graphError");
const graphFitBtn = document.getElementById("graphFitBtn");
const graphZoomInBtn = document.getElementById("graphZoomInBtn");
const graphZoomOutBtn = document.getElementById("graphZoomOutBtn");
const graphResetBtn = document.getElementById("graphResetBtn");

// Toast Container
const toastContainer = document.getElementById("toastContainer");

// Global Cytoscape Graph & Voice State
let cy = null;
let lastAnswerText = "";
let loadingInterval = null;

// Speech Recognition & Speech Synthesis State
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isRecording = false;
let isSpeaking = false;

// Initialize Event Listeners
document.addEventListener("DOMContentLoaded", () => {
  // Main Analyze Action
  analyzeBtn.addEventListener("click", analyze);
  if (errorRetryBtn) errorRetryBtn.addEventListener("click", analyze);
  if (clearBtn) clearBtn.addEventListener("click", clearQuery);

  // Microphone Voice Input Listener
  if (micBtn) micBtn.addEventListener("click", toggleSpeechRecognition);

  // Text-To-Speech Listen Button
  if (ttsBtn) ttsBtn.addEventListener("click", toggleTextToSpeech);

  // Character Counter
  problemText.addEventListener("input", updateCharCount);
  updateCharCount();

  // Example Chips Click Handler
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const q = chip.dataset.query;
      const lang = chip.dataset.lang;
      if (q) {
        problemText.value = q;
        if (lang && languageSelect) {
          languageSelect.value = lang;
        }
        updateCharCount();
        problemText.focus();
        showToast("Example query loaded!", "info", 2000);
      }
    });
  });

  // Copy Answer Action
  if (copyAnswerBtn) {
    copyAnswerBtn.addEventListener("click", copyAnswerToClipboard);
  }

  // Graph Toolbar Actions
  if (graphFitBtn) {
    graphFitBtn.addEventListener("click", () => {
      if (cy) cy.fit(undefined, 30);
    });
  }
  if (graphZoomInBtn) {
    graphZoomInBtn.addEventListener("click", () => {
      if (cy) cy.zoom({ level: cy.zoom() * 1.25, renderPyramid: true });
    });
  }
  if (graphZoomOutBtn) {
    graphZoomOutBtn.addEventListener("click", () => {
      if (cy) cy.zoom({ level: cy.zoom() * 0.8, renderPyramid: true });
    });
  }
  if (graphResetBtn) {
    graphResetBtn.addEventListener("click", () => {
      if (cy) {
        const layout = cy.layout({ name: "cose", animate: true, padding: 30, nodeRepulsion: 9000 });
        layout.run();
      }
    });
  }

  // Close Node Detail Drawer
  if (closeDetailBtn) {
    closeDetailBtn.addEventListener("click", () => {
      nodeDetail.classList.add("hidden");
    });
  }

  // Tab Link Scroll Handler
  document.querySelectorAll(".tab-link").forEach((link) => {
    link.addEventListener("click", () => {
      document.querySelectorAll(".tab-link").forEach((tl) => tl.classList.remove("active"));
      link.classList.add("active");
    });
  });
});

// Toast Notification System
function showToast(message, type = "info", duration = 3000) {
  if (!toastContainer) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${esc(message)}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(50px)";
    toast.style.transition = "all 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Character Counter
function updateCharCount() {
  const len = problemText.value.length;
  if (charCount) {
    charCount.textContent = `${len} character${len === 1 ? "" : "s"}`;
  }
}

// Clear Query Input
function clearQuery() {
  problemText.value = "";
  updateCharCount();
  errorBox.classList.add("hidden");
  problemText.focus();
}

// ==========================================================================
// SPEECH-TO-TEXT (MICROPHONE VOICE INPUT)
// ==========================================================================
function toggleSpeechRecognition() {
  if (!SpeechRecognition) {
    showToast("Speech recognition is not supported in this browser. Please type your question instead.", "error", 4000);
    return;
  }

  if (isRecording) {
    if (recognition) recognition.stop();
    return;
  }

  const lang = languageSelect ? languageSelect.value : "English";
  let langCode = "en-IN";
  if (lang === "Telugu") langCode = "te-IN";
  else if (lang === "Hindi") langCode = "hi-IN";

  try {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = langCode;

    recognition.onstart = () => {
      isRecording = true;
      if (micBtn) micBtn.classList.add("recording");
      if (micBtnText) micBtnText.textContent = "Stop Recording";
      if (voiceStatusText) voiceStatusText.textContent = `🔴 Listening (${lang})... Speak your question now`;
      if (voiceStatus) voiceStatus.classList.remove("hidden");
      showToast(`Listening in ${lang}... Speak your question`, "info", 3000);
    };

    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      problemText.value = transcript;
      updateCharCount();
    };

    recognition.onerror = (event) => {
      console.error("Speech recognition error:", event.error);
      stopRecordingUI();
      if (event.error === "not-allowed" || event.error === "permission-denied") {
        showToast("Microphone permission is required to use voice input.", "error", 4500);
      } else if (event.error === "no-speech") {
        showToast("No speech detected. Please try speaking again.", "error", 3500);
      } else {
        showToast("Voice recognition error. Please type your question.", "error", 3500);
      }
    };

    recognition.onend = () => {
      stopRecordingUI();
      if (voiceStatusText) voiceStatusText.textContent = "Processing speech...";
      setTimeout(() => {
        if (voiceStatus) voiceStatus.classList.add("hidden");
      }, 1800);
    };

    recognition.start();
  } catch (err) {
    console.error("Failed to start speech recognition:", err);
    stopRecordingUI();
    showToast("Could not start voice recognition. Please try typing.", "error");
  }
}

function stopRecordingUI() {
  isRecording = false;
  if (micBtn) micBtn.classList.remove("recording");
  if (micBtnText) micBtnText.textContent = "Voice Input";
}

// ==========================================================================
// TEXT-TO-SPEECH (READ ALOUD ANSWER)
// ==========================================================================
function toggleTextToSpeech() {
  if (!("speechSynthesis" in window)) {
    showToast("Text-to-speech is not supported in this browser.", "error");
    return;
  }

  if (isSpeaking) {
    window.speechSynthesis.cancel();
    isSpeaking = false;
    if (ttsBtnText) ttsBtnText.textContent = "Listen 🔊";
    if (ttsBtn) ttsBtn.classList.remove("active-speaking");
    return;
  }

  if (!lastAnswerText) {
    showToast("No analysis answer available to read.", "info");
    return;
  }

  // Clean formatting markdown symbols for spoken reading
  const cleanText = lastAnswerText
    .replace(/[\*\#\-\_\`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const utterance = new SpeechSynthesisUtterance(cleanText);
  const currentLang = responseLangText ? responseLangText.textContent : "English";

  let langCode = "en-IN";
  if (/telugu/i.test(currentLang)) langCode = "te-IN";
  else if (/hindi/i.test(currentLang)) langCode = "hi-IN";

  utterance.lang = langCode;
  utterance.rate = 0.92;

  // Try finding a native voice match in browser
  const voices = window.speechSynthesis.getVoices();
  const voiceMatch = voices.find(
    (v) => v.lang === langCode || v.lang.startsWith(langCode.slice(0, 2))
  );
  if (voiceMatch) utterance.voice = voiceMatch;

  utterance.onstart = () => {
    isSpeaking = true;
    if (ttsBtnText) ttsBtnText.textContent = "Stop ⏹️";
    if (ttsBtn) ttsBtn.classList.add("active-speaking");
    showToast(`Reading answer in ${currentLang}...`, "info", 2500);
  };

  utterance.onend = () => {
    isSpeaking = false;
    if (ttsBtnText) ttsBtnText.textContent = "Listen 🔊";
    if (ttsBtn) ttsBtn.classList.remove("active-speaking");
  };

  utterance.onerror = (err) => {
    console.error("Speech synthesis error:", err);
    isSpeaking = false;
    if (ttsBtnText) ttsBtnText.textContent = "Listen 🔊";
    if (ttsBtn) ttsBtn.classList.remove("active-speaking");
  };

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

// ==========================================================================
// MAIN ANALYZE FUNCTION
// ==========================================================================
async function analyze() {
  const text = problemText.value.trim();
  const selectedLang = languageSelect ? languageSelect.value : "English";

  errorBox.classList.add("hidden");
  results.classList.add("hidden");
  nodeDetail.classList.add("hidden");
  graphError.classList.add("hidden");

  // Stop any active speech synthesis
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();

  if (!text) {
    showError("Please describe your agricultural problem or observation.");
    showToast("Please enter an agricultural question.", "error");
    return;
  }
  if (text.length < 15) {
    showError("Please write a fuller sentence (including crop name, symptoms, or soil/weather conditions).");
    showToast("Query is too short. Add more details.", "error");
    return;
  }

  startLoadingAnimation();
  analyzeBtn.disabled = true;

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: text,
        language: selectedLang
      })
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = data.details
        ? data.error + " — " + data.details
        : data.error || "Unable to analyze query. Please try again.";
      throw new Error(msg);
    }
    showAll(data);
    showToast(`Analysis complete in ${data.language || selectedLang}!`, "success", 2500);
  } catch (err) {
    showError(err.message || "Unable to analyze query. Please try again.");
    showToast("Analysis error occurred.", "error", 4000);
  } finally {
    stopLoadingAnimation();
    analyzeBtn.disabled = false;
  }
}

// Rotating Loading Messages Animation
function startLoadingAnimation() {
  loading.classList.remove("hidden");
  const steps = [
    { text: "Understanding your agricultural question...", pct: "20%" },
    { text: "Searching agricultural concepts & semantic mappings...", pct: "40%" },
    { text: "Querying Neo4j Knowledge Graph & embeddings...", pct: "60%" },
    { text: "Retrieving research literature (PDFs + OpenAlex)...", pct: "75%" },
    { text: "Checking literature conflict evidence...", pct: "90%" },
    { text: "Synthesizing AI Agricultural Insight with Gemini...", pct: "95%" }
  ];

  let stepIdx = 0;
  if (loadingStepText) loadingStepText.textContent = steps[0].text;
  if (loadingProgress) loadingProgress.style.width = steps[0].pct;

  if (loadingInterval) clearInterval(loadingInterval);
  loadingInterval = setInterval(() => {
    stepIdx = (stepIdx + 1) % steps.length;
    if (loadingStepText) {
      loadingStepText.style.opacity = "0.4";
      setTimeout(() => {
        loadingStepText.textContent = steps[stepIdx].text;
        loadingStepText.style.opacity = "1";
      }, 150);
    }
    if (loadingProgress) loadingProgress.style.width = steps[stepIdx].pct;
  }, 1600);
}

function stopLoadingAnimation() {
  if (loadingInterval) clearInterval(loadingInterval);
  loading.classList.add("hidden");
}

// Display Error Message
function showError(msg) {
  if (errorText) errorText.textContent = msg;
  errorBox.classList.remove("hidden");
  errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Render All Results
function showAll(data) {
  results.classList.remove("hidden");

  if (responseLangText) {
    responseLangText.textContent = data.language || (languageSelect ? languageSelect.value : "English");
  }

  showAnswer(data);
  showDetected(data);
  showSemantic(data);
  showSources(data);
  showConflicts(data);

  // Draw Cytoscape graph after container is visible
  setTimeout(() => {
    drawGraph(data.graph || { nodes: [], relationships: [] });
  }, 100);

  results.scrollIntoView({ behavior: "smooth", block: "start" });
}

// 1. Render Final AI Answer
function showAnswer(data) {
  const box = document.getElementById("answer");
  const answer = data.answer || "No answer generated.";
  lastAnswerText = answer;

  // Process markdown formatting (paragraphs, bold text, bullet points)
  const paragraphs = answer.split(/\n+/).filter(Boolean);
  let html = "";

  paragraphs.forEach((p) => {
    let cleanP = esc(p);
    cleanP = cleanP.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    
    if (p.trim().startsWith("- ") || p.trim().startsWith("* ")) {
      html += `<li>${cleanP.replace(/^[-*]\s+/, "")}</li>`;
    } else {
      html += `<p>${cleanP}</p>`;
    }
  });

  if (html.includes("<li>")) {
    html = html.replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>");
  }

  box.innerHTML = html;
}

// Copy Answer to Clipboard
async function copyAnswerToClipboard() {
  if (!lastAnswerText) return;
  try {
    await navigator.clipboard.writeText(lastAnswerText);
    if (copyBtnText) copyBtnText.textContent = "Copied!";
    showToast("AI Insight copied to clipboard!", "success");
    setTimeout(() => {
      if (copyBtnText) copyBtnText.textContent = "Copy Insight";
    }, 2000);
  } catch (err) {
    showToast("Failed to copy text.", "error");
  }
}

// Helper: Provenance Label Formatting
function provenanceLabel(source) {
  const s = String(source || "").toUpperCase();
  if (s === "USER_QUERY" || s === "USER" || s === "USER INPUT") return "User Query Input";
  if (s === "LLM_INFERENCE" || s === "INFERENCE" || s === "AI") return "LLM Inference";
  if (s === "SEMANTIC_SEARCH" || s === "SEMANTIC_SEARCH_FALLBACK") return "Semantic Vector Index";
  if (s === "OPENALEX" || s === "RESEARCH_PAPER") return "Research Literature (OpenAlex)";
  return source || "Neo4j Knowledge Base";
}

// 2. Render Detected Entities Dashboard
function showDetected(data) {
  const box = document.getElementById("detected");
  const d = data.detected || {};

  const crops = d.crops || [];
  const scientificNames = d.scientificNames || [];
  const symptoms = d.symptoms || [];
  const diseases = d.diseases || (d.possibleDiseases || []).map((x) => x.name || x);
  const soil = d.soil || [];
  const weather = d.weather || [];
  const treatments = d.treatments || [];

  if (!crops.length && !symptoms.length && (d.entities || data.entities || []).length) {
    const entities = d.entities || data.entities || [];
    const byType = (t) => entities.filter((e) => e.type === t).map((e) => e.canonical || e.name);
    return renderDetectedDashboard(box, {
      crops: byType("Crop"),
      scientificNames: entities.map((e) => e.scientificName).filter(Boolean),
      symptoms: byType("Symptom"),
      diseases: (d.possibleDiseases || data.possibleDiseases || []).map((x) => x.name || x),
      soil: byType("Soil"),
      weather: byType("Weather"),
      treatments: (data.treatments || []).map((t) => t.name).filter(Boolean)
    });
  }

  renderDetectedDashboard(box, {
    crops,
    scientificNames,
    symptoms,
    diseases,
    soil,
    weather,
    treatments
  });
}

function renderDetectedDashboard(box, d) {
  const sections = [
    { title: "Target Crops", icon: "🌾", items: d.crops, tagClass: "crop" },
    { title: "Scientific Names", icon: "🔬", items: d.scientificNames, tagClass: "scientific" },
    { title: "Observed Symptoms", icon: "🍂", items: d.symptoms, tagClass: "symptom" },
    { title: "Possible Diseases / Conditions", icon: "🦠", items: d.diseases, tagClass: "disease" },
    { title: "Soil Factors", icon: "🪵", items: d.soil, tagClass: "soil" },
    { title: "Weather & Climate", icon: "🌧️", items: d.weather, tagClass: "weather" },
    { title: "Treatments & Care", icon: "💊", items: d.treatments, tagClass: "treatment" }
  ];

  const activeSections = sections.filter((s) => s.items && s.items.length);

  if (!activeSections.length) {
    box.innerHTML = '<div class="detect-card"><p class="empty-msg">No specific agricultural entities detected in query.</p></div>';
    return;
  }

  box.innerHTML = `
    <div class="detected-grid">
      ${sections
        .map((s) => {
          const hasItems = s.items && s.items.length;
          return `
            <div class="detect-card">
              <div class="detect-card-header">
                <span>${s.icon}</span>
                <h4>${esc(s.title)}</h4>
              </div>
              <div class="entity-tags">
                ${
                  hasItems
                    ? s.items.map((item) => `<span class="tag ${s.tagClass}">${esc(item)}</span>`).join("")
                    : '<span class="tag empty">None reported</span>'
                }
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

// 3. Render Semantic Mapping
function showSemantic(data) {
  const box = document.getElementById("semantic");
  const items = data.semanticIntegration || [];

  if (!items.length) {
    box.innerHTML = '<p class="empty-msg">No raw query terms required canonical mapping.</p>';
    return;
  }

  box.innerHTML = `
    <ul class="semantic-list">
      ${items
        .map(
          (s) => `
          <li class="semantic-item">
            <div class="semantic-pair">
              <span class="semantic-orig">${esc(s.original)}</span>
              <span class="semantic-arrow">→</span>
              <span class="semantic-canon">${esc(s.canonical)}</span>
            </div>
            <div class="semantic-badges">
              <span class="badge-sub type">${esc(s.type)}</span>
              ${s.matchType ? `<span class="badge-sub">${esc(s.matchType)}</span>` : ""}
              ${s.source ? `<span class="badge-sub source">${esc(provenanceLabel(s.source))}</span>` : ""}
            </div>
          </li>
        `
        )
        .join("")}
    </ul>
  `;
}

// 4. Render Research Papers Evidence
function showSources(data) {
  const box = document.getElementById("sources");
  const sources = data.sources || [];
  const papers = data.papers || [];

  if (data.papersError && !sources.length && !papers.length) {
    box.innerHTML = `<p class="empty-msg">${esc(data.papersError)}</p>`;
    return;
  }

  if (!sources.length && !papers.length) {
    box.innerHTML = '<p class="empty-msg">No relevant research papers retrieved for this query.</p>';
    return;
  }

  if (sources.length) {
    const seen = {};
    const unique = sources.filter((s) => {
      const k = (s.title || "").toLowerCase();
      if (!k || seen[k]) return false;
      seen[k] = true;
      return true;
    });

    box.innerHTML = unique
      .map((s, idx) => {
        const link = s.url
          ? `<a href="${escAttr(s.url)}" target="_blank" rel="noopener noreferrer" class="paper-link">View Full Source ↗</a>`
          : "";
        const provenanceBadge = s.fileName
          ? `<span class="tag crop">Local Agronomy PDF</span>`
          : `<span class="tag scientific">OpenAlex Index</span>`;

        return `
          <div class="paper-card">
            <div>
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 0.4rem;">
                <span class="badge-sub type">Paper ${idx + 1}</span>
                ${provenanceBadge}
              </div>
              <h3 class="paper-title">${esc(s.title || "Untitled Paper")}</h3>
              <div class="paper-meta">
                <strong>Authors:</strong> ${esc(s.authors || "Not listed")} (${esc(s.year || "N/A")})
                ${s.fileName ? `· <em>${esc(s.fileName)}</em>` : ""}
              </div>
              ${
                s.finding
                  ? `<div class="paper-finding"><strong>Finding:</strong> ${esc(s.finding)}</div>`
                  : ""
              }
            </div>
            <div class="paper-footer">
              <span class="badge-sub source">${esc(s.provenance || "RESEARCH_PAPER")}</span>
              ${link}
            </div>
          </div>
        `;
      })
      .join("");
    return;
  }

  box.innerHTML = papers
    .map((p, idx) => {
      const authors = Array.isArray(p.authors) ? p.authors.join(", ") : p.authors || "Not listed";
      const link = p.url
        ? `<a href="${escAttr(p.url)}" target="_blank" rel="noopener noreferrer" class="paper-link">View OpenAlex Source ↗</a>`
        : "";
      return `
        <div class="paper-card">
          <div>
            <span class="badge-sub type">Paper ${idx + 1}</span>
            <h3 class="paper-title">${esc(p.title)}</h3>
            <div class="paper-meta">
              <strong>Authors:</strong> ${esc(authors)} (${esc(p.year || "N/A")})
            </div>
          </div>
          <div class="paper-footer">
            <span class="badge-sub source">OpenAlex Catalog</span>
            ${link}
          </div>
        </div>
      `;
    })
    .join("");
}

// 5. Render Conflicting Evidence Section
function showConflicts(data) {
  const box = document.getElementById("conflicts");
  const conflicts = data.conflicts || [];
  const summary = data.conflictsSummary || "";

  if (!conflicts.length) {
    box.innerHTML = `
      <div class="no-conflicts-card">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <span>${esc(summary || "No conflicting research evidence detected across literature sources.")}</span>
      </div>
    `;
    return;
  }

  let html = `<p class="card-subtitle" style="margin-bottom: 0.8rem;">${esc(summary || "Contradictions or alternative perspectives identified in papers.")}</p>`;
  html += conflicts
    .map((c) => {
      const sourceA = typeof c.sourceA === "string" ? c.sourceA : (c.sourceA?.paperTitle || c.sourceA?.claim || "Source A");
      const sourceB = typeof c.sourceB === "string" ? c.sourceB : (c.sourceB?.paperTitle || c.sourceB?.claim || "Source B");
      const claimA = c.claimA || c.sourceA?.claim || "";
      const claimB = c.claimB || c.sourceB?.claim || "";

      return `
        <div class="conflict-card">
          <div class="conflict-card-header">
            <span class="tag disease">${esc(c.type === "contradiction" ? "Literature Contradiction" : "Alternative Evidence")}</span>
            <h3>${esc(c.topic ? "Topic: " + c.topic : "Disputed Finding")}</h3>
          </div>
          <div class="conflict-claims">
            <div class="claim-box">
              <h5>Source A (${esc(sourceA)})</h5>
              <p>${esc(claimA || "Asserts initial treatment/finding hypothesis.")}</p>
            </div>
            <div class="claim-box">
              <h5>Source B (${esc(sourceB)})</h5>
              <p>${esc(claimB || "Presents contrasting or condition-dependent finding.")}</p>
            </div>
          </div>
          <p class="conflict-note">${esc(c.explanation || c.note || "Both perspectives are preserved in the knowledge graph for research accuracy.")}</p>
        </div>
      `;
    })
    .join("");

  box.innerHTML = html;
}

// 6. Cytoscape Knowledge Graph Interactive Renderer
function drawGraph(graph) {
  graphError.classList.add("hidden");

  if (typeof cytoscape === "undefined") {
    console.error("Cytoscape library not loaded");
    graphError.textContent = "Cytoscape library not loaded. Please refresh your page.";
    graphError.classList.remove("hidden");
    return;
  }

  const container = document.getElementById("knowledgeGraph");
  if (!container) return;

  const nodes = graph.nodes || [];
  const edges = graph.relationships || graph.edges || [];

  if (!nodes.length) {
    graphError.textContent = "Neo4j returned no graph nodes for this analysis.";
    graphError.classList.remove("hidden");
    return;
  }

  const elements = [];

  nodes.forEach((n) => {
    elements.push({
      data: {
        id: String(n.id),
        label: n.label || n.name || n.id,
        type: n.type || "Entity",
        confidence: n.confidence,
        source: n.source,
        reason: n.reason,
        url: n.url,
        doi: n.doi,
        authors: n.authors,
        year: n.publicationYear || n.year,
        original: n.original,
        scientificName: n.scientificName,
        uncertain: n.uncertain,
        text: n.text,
        fileName: n.fileName
      }
    });
  });

  edges.forEach((e, i) => {
    elements.push({
      data: {
        id: String(e.id || "e" + i),
        source: String(e.source),
        target: String(e.target),
        label: e.label || e.relation || ""
      }
    });
  });

  if (cy) {
    cy.destroy();
    cy = null;
  }

  cy = cytoscape({
    container,
    elements,
    style: [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "text-wrap": "wrap",
          "text-max-width": 90,
          "font-family": "Inter, sans-serif",
          "font-size": 11,
          "font-weight": 600,
          color: "#1e293b",
          "text-valign": "center",
          "text-halign": "center",
          width: 76,
          height: 76,
          "background-color": "#a5d6a7",
          "border-width": 2,
          "border-color": "#2e7d32",
          "transition-property": "background-color, border-color, width, height, opacity",
          "transition-duration": "0.2s"
        }
      },
      { selector: 'node[type="Crop"]', style: { "background-color": "#66bb6a", "border-color": "#1b5e20", width: 86, height: 86, "font-size": 12 } },
      { selector: 'node[type="Disease"]', style: { "background-color": "#ef9a9a", "border-color": "#c62828", color: "#881337" } },
      { selector: 'node[type="Symptom"]', style: { "background-color": "#ffcc80", "border-color": "#ef6c00", color: "#7c2d12" } },
      { selector: 'node[type="Soil"]', style: { "background-color": "#bcaaa4", "border-color": "#5d4037" } },
      { selector: 'node[type="Weather"]', style: { "background-color": "#81d4fa", "border-color": "#0277bd" } },
      { selector: 'node[type="Treatment"]', style: { "background-color": "#ffe082", "border-color": "#f9a825" } },
      { selector: 'node[type="ResearchPaper"]', style: { "background-color": "#ce93d8", "border-color": "#7b1fa2", color: "#4c1d95" } },
      {
        selector: "edge",
        style: {
          width: 2.5,
          "line-color": "#40916c",
          "target-arrow-color": "#40916c",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          label: "data(label)",
          "font-size": 9,
          "font-weight": 600,
          color: "#143626",
          "text-rotation": "autorotate",
          "text-margin-y": -7,
          "transition-property": "line-color, target-arrow-color, width",
          "transition-duration": "0.2s"
        }
      },
      {
        selector: ".highlighted",
        style: {
          "border-width": 4,
          "border-color": "#1b4332",
          "shadow-blur": 10,
          "shadow-color": "#52b788",
          "shadow-opacity": 0.8
        }
      },
      {
        selector: ".dimmed",
        style: {
          opacity: 0.25
        }
      }
    ],
    layout: {
      name: "cose",
      animate: true,
      animationDuration: 500,
      padding: 40,
      nodeRepulsion: 10000,
      idealEdgeLength: 100
    },
    userZoomingEnabled: true,
    userPanningEnabled: true
  });

  setTimeout(() => {
    if (cy) {
      cy.resize();
      cy.fit(undefined, 35);
    }
  }, 120);

  // Hover Highlight Interactions
  cy.on("mouseover", "node", (evt) => {
    const targetNode = evt.target;
    const connectedEdges = targetNode.connectedEdges();
    const connectedNodes = connectedEdges.connectedNodes();

    cy.elements().addClass("dimmed");
    targetNode.removeClass("dimmed").addClass("highlighted");
    connectedNodes.removeClass("dimmed");
    connectedEdges.removeClass("dimmed").style({ "width": 4, "line-color": "#1b4332", "target-arrow-color": "#1b4332" });
  });

  cy.on("mouseout", "node", () => {
    cy.elements().removeClass("dimmed").removeClass("highlighted");
    cy.edges().style({ "width": 2.5, "line-color": "#40916c", "target-arrow-color": "#40916c" });
  });

  // Tap / Click Node Details
  cy.on("tap", "node", (evt) => {
    const d = evt.target.data();
    let html = `
      <p><strong>Entity Name:</strong> ${esc(d.label || "—")}</p>
      <p><strong>Category Type:</strong> <span class="tag crop">${esc(d.type || "—")}</span></p>
      <p><strong>Provenance Source:</strong> ${esc(provenanceLabel(d.source))}</p>
    `;
    if (d.scientificName) {
      html += `<p><strong>Scientific Taxonomy:</strong> <em>${esc(d.scientificName)}</em></p>`;
    }
    if (d.original && d.original !== d.label) {
      html += `<p><strong>Raw Query Wording:</strong> ${esc(d.original)}</p>`;
    }
    if (d.reason) html += `<p><strong>Evidence Link:</strong> ${esc(d.reason)}</p>`;
    if (d.uncertain) html += `<p><strong>Reliability Note:</strong> <span class="tag symptom">Uncertain — Verify in Field</span></p>`;
    if (d.authors) html += `<p><strong>Authors:</strong> ${esc(d.authors)}</p>`;
    if (d.year) html += `<p><strong>Publication Year:</strong> ${esc(d.year)}</p>`;
    if (d.fileName) html += `<p><strong>PDF Document:</strong> ${esc(d.fileName)}</p>`;
    if (d.doi) html += `<p><strong>DOI:</strong> ${esc(d.doi)}</p>`;
    if (d.text) html += `<p><strong>Ingested Text Snippet:</strong> "${esc(d.text)}"</p>`;
    if (d.url) {
      html += `<p><strong>Literature Link:</strong> <a href="${escAttr(d.url)}" target="_blank" rel="noopener noreferrer" class="paper-link">${esc(d.url)} ↗</a></p>`;
    }

    if (nodeDetailBody) nodeDetailBody.innerHTML = html;
    nodeDetail.classList.remove("hidden");
    nodeDetail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}

// Utility String Escaping
function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(str) {
  return esc(str).replace(/'/g, "&#39;");
}
