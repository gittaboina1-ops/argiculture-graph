const express = require("express");
const path = require("path");
const fs = require("fs");
const neo4j = require("neo4j-driver");
const { GoogleGenAI } = require("@google/genai");
require("dotenv").config();

// pdf-parse is optional until first PDF ingest
let pdfParse = null;
try {
  pdfParse = require("pdf-parse");
} catch (_) {
  console.warn("pdf-parse not installed - PDF ingest disabled until npm install pdf-parse");
}

const app = express();
const PORT = process.env.PORT || 3000;
const RESEARCH_DIR = path.join(__dirname, "research");
const ingestInProgress = new Set();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

const ALLOWED_RELATIONS = [
  "HAS_SYMPTOM",
  "GROWS_IN",
  "EXPOSED_TO",
  "POSSIBLY_HAS_DISEASE",
  "TREATED_BY",
  "SUPPORTED_BY",
  "DISPUTED_BY",
  "ALTERNATIVE_TO",
  "ASSOCIATED_WITH"
];

const ALLOWED_LABELS = [
  "Crop",
  "Disease",
  "Symptom",
  "Soil",
  "Weather",
  "Treatment",
  "ResearchPaper"
];

const GEMINI_MODELS = (
  process.env.GEMINI_MODEL ||
  "gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-3.8-flash,gemini-3-flash-preview"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const EMBEDDING_DIM = 768;

// ---------- helpers ----------
function cleanJson(text) {
  text = String(text || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```json/i, "");
    text = text.replace(/^```/, "");
    text = text.replace(/```$/, "");
  }
  return text.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeLabel(type) {
  let cleaned = String(type || "").replace(/[^a-zA-Z]/g, "");
  // Map Condition → Disease (existing graph model); keep simple for MVP
  if (cleaned === "Condition") cleaned = "Disease";
  return ALLOWED_LABELS.includes(cleaned) ? cleaned : null;
}

function safeRel(rel) {
  let cleaned = String(rel || "")
    .toUpperCase()
    .replace(/[^A-Z_]/g, "");
  // Normalize common LLM variants to controlled list
  if (cleaned === "MAY_CAUSE" || cleaned === "CAUSES" || cleaned === "LEADS_TO") {
    cleaned = "ASSOCIATED_WITH";
  }
  if (cleaned === "FROM") return null;
  return ALLOWED_RELATIONS.includes(cleaned) ? cleaned : null;
}

function findEntityName(extracted, type) {
  const e = (extracted.entities || []).find((x) => x.type === type);
  return e ? e.name : "";
}

function titleCase(text) {
  return String(text)
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function reconstructAbstract(inverted) {
  if (!inverted || typeof inverted !== "object") return "";
  const words = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const pos of positions) words[pos] = word;
  }
  return words.filter(Boolean).join(" ").slice(0, 1200);
}

// ---------- Simple Semantic Data Integration ----------
const CANONICAL_MAP = {
  tomato: "Tomato",
  tomatoes: "Tomato",
  "tomato plant": "Tomato",
  "tomato plants": "Tomato",
  "my tomato plants": "Tomato",
  "solanum lycopersicum": "Tomato",
  cotton: "Cotton",
  "cotton plant": "Cotton",
  "cotton plants": "Cotton",
  "cotton crop": "Cotton",
  "my cotton plants": "Cotton",
  "gossypium hirsutum": "Cotton",
  "brown spots": "Brown spots on leaves",
  "brown spots on leaves": "Brown spots on leaves",
  "brown spots on the leaves": "Brown spots on leaves",
  "dark brown spots": "Brown spots on leaves",
  "dark brown spots on their leaves": "Brown spots on leaves",
  "dark brown leaf spots": "Brown spots on leaves",
  "brown patches on leaves": "Brown spots on leaves",
  "drying leaves": "Drying Leaves",
  "leaf fall": "Leaf Fall",
  "leaves are starting to dry and fall": "Drying Leaves",
  "yellow leaves": "Leaf Yellowing / Chlorosis",
  "yellowing leaves": "Leaf Yellowing / Chlorosis",
  "leaf yellowing": "Leaf Yellowing / Chlorosis",
  "pale yellow leaves": "Leaf Yellowing / Chlorosis",
  "pale yellow": "Leaf Yellowing / Chlorosis",
  "turning pale yellow": "Leaf Yellowing / Chlorosis",
  chlorosis: "Leaf Yellowing / Chlorosis",
  "leaf chlorosis": "Leaf Yellowing / Chlorosis",
  "poor growth": "Poor Growth",
  "growing slowly": "Poor Growth",
  "slow growth": "Poor Growth",
  loamy: "Loamy Soil",
  "loamy soil": "Loamy Soil",
  "loam soil": "Loamy Soil",
  "dry soil": "Dry Soil / Water Stress",
  "very dry": "Dry Soil / Water Stress",
  "soil is very dry": "Dry Soil / Water Stress",
  "dry field": "Dry Soil / Water Stress",
  "water-deficient soil": "Dry Soil / Water Stress",
  "water deficient soil": "Dry Soil / Water Stress",
  "water-deficient soil conditions": "Dry Soil / Water Stress",
  "low soil moisture": "Dry Soil / Water Stress",
  "water deficiency": "Dry Soil / Water Stress",
  "not received enough water": "Dry Soil / Water Stress",
  drought: "Dry Soil / Water Stress",
  "drought stress": "Dry Soil / Water Stress",
  "water stress": "Water Stress",
  humid: "High Humidity",
  humidity: "High Humidity",
  "high humidity": "High Humidity",
  "very humid": "High Humidity",
  "high moisture": "High Humidity",
  "humid conditions": "High Humidity",
  rainfall: "Frequent Rainfall",
  rain: "Frequent Rainfall",
  "frequent rain": "Frequent Rainfall",
  "frequent rainfall": "Frequent Rainfall",
  "heavy rainfall": "Frequent Rainfall",
  "little rainfall": "Low Rainfall",
  "very little rainfall": "Low Rainfall",
  "low rainfall": "Low Rainfall",
  "early blight": "Early Blight",
  "septoria leaf spot": "Septoria Leaf Spot",
  "nutrient deficiency": "Nutrient Deficiency",
  "alternaria solani": "Early Blight"
};

// Reliable scientific-name â†’ canonical mapping (NOT only vector similarity)
const SCIENTIFIC_NAME_ALIASES = {
  "gossypium hirsutum": {
    canonical: "Cotton",
    type: "Crop",
    scientificName: "Gossypium hirsutum"
  },
  "solanum lycopersicum": {
    canonical: "Tomato",
    type: "Crop",
    scientificName: "Solanum lycopersicum"
  },
  "alternaria solani": {
    canonical: "Early Blight",
    type: "Disease",
    scientificName: "Alternaria solani"
  }
};

const CONCEPT_BANK = [
  {
    id: "cotton",
    canonical: "Cotton",
    type: "Crop",
    scientificName: "Gossypium hirsutum",
    text: "Cotton crop plant Gossypium hirsutum fibre agriculture"
  },
  {
    id: "tomato",
    canonical: "Tomato",
    type: "Crop",
    scientificName: "Solanum lycopersicum",
    text: "Tomato crop plant Solanum lycopersicum vegetable agriculture"
  },
  {
    id: "chlorosis",
    canonical: "Leaf Yellowing / Chlorosis",
    type: "Symptom",
    scientificName: "",
    text: "Yellow leaves leaf yellowing chlorosis pale foliage nutrient or water stress symptom"
  },
  {
    id: "poor_growth",
    canonical: "Poor Growth",
    type: "Symptom",
    scientificName: "",
    text: "Poor growth slow growth stunted plants growing slowly reduced vigor"
  },
  {
    id: "brown_spots",
    canonical: "Brown spots on leaves",
    type: "Symptom",
    scientificName: "",
    text: "Brown spots on leaves leaf blight lesions foliar disease symptom"
  },
  {
    id: "dry_soil",
    canonical: "Dry Soil / Water Stress",
    type: "Soil",
    scientificName: "",
    text: "Dry soil drought water deficient soil low soil moisture water stress"
  },
  {
    id: "loamy_soil",
    canonical: "Loamy Soil",
    type: "Soil",
    scientificName: "",
    text: "Loamy soil loam fertile balanced soil texture"
  },
  {
    id: "low_rainfall",
    canonical: "Low Rainfall",
    type: "Weather",
    scientificName: "",
    text: "Low rainfall little rain dry weather drought conditions"
  },
  {
    id: "high_humidity",
    canonical: "High Humidity",
    type: "Weather",
    scientificName: "",
    text: "High humidity humid moist air wet weather"
  },
  {
    id: "frequent_rain",
    canonical: "Frequent Rainfall",
    type: "Weather",
    scientificName: "",
    text: "Frequent rainfall heavy rain wet season"
  },
  {
    id: "water_stress",
    canonical: "Water Stress",
    type: "Disease",
    scientificName: "",
    text: "Water stress drought stress water deficiency irrigation shortage"
  },
  {
    id: "early_blight",
    canonical: "Early Blight",
    type: "Disease",
    scientificName: "Alternaria solani",
    text: "Early blight Alternaria tomato potato brown leaf spots fungal disease"
  },
  {
    id: "nutrient_def",
    canonical: "Nutrient Deficiency",
    type: "Disease",
    scientificName: "",
    text: "Nutrient deficiency nitrogen deficiency chlorosis pale yellow leaves fertilizer"
  }
];

let conceptEmbeddings = null;

async function embedText(text) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing.");
  }

  // gemini-embedding-001 supports outputDimensionality (keep 768 for Neo4j vector index)
  const model = process.env.EMBEDDING_MODEL || "gemini-embedding-001";
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    model +
    ":embedContent?key=" +
    process.env.GEMINI_API_KEY;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "models/" + model,
      content: { parts: [{ text: String(text || "").slice(0, 2000) }] },
      outputDimensionality: EMBEDDING_DIM
    })
  });

  const bodyText = await res.text();
  if (!res.ok) {
    console.error("Semantic search error (embedding):", bodyText);
    throw new Error("Semantic search failed.");
  }

  const data = JSON.parse(bodyText);
  const values = data?.embedding?.values;
  if (!values || !values.length) {
    throw new Error("Semantic search failed: empty embedding");
  }
  return values;
}

async function ensureConceptEmbeddings() {
  if (conceptEmbeddings) return conceptEmbeddings;
  console.log("Building concept embeddings for semantic search...");
  const list = [];
  for (const c of CONCEPT_BANK) {
    const vector = await embedText(c.text);
    list.push({ ...c, vector });
  }
  conceptEmbeddings = list;
  console.log("Concept embeddings ready:", list.length);
  return list;
}

async function semanticSearch(query) {
  const qLower = String(query).toLowerCase();
  const aliasMatches = [];

  // 1) Reliable scientific-name / alias matching FIRST (not only vectors)
  for (const [alias, info] of Object.entries(SCIENTIFIC_NAME_ALIASES)) {
    if (!qLower.includes(alias)) continue;
    aliasMatches.push({
      id: "alias_" + alias.replace(/\s+/g, "_"),
      original: info.scientificName || alias,
      canonical: info.canonical,
      type: info.type,
      scientificName: info.scientificName || "",
      score: 1,
      source: "SCIENTIFIC_NAME_ALIAS",
      matchType: "scientific-name"
    });
  }

  // Also match longer CANONICAL_MAP phrases that appear in the query
  const phraseMatches = [];
  const phrases = Object.keys(CANONICAL_MAP).sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    if (phrase.length < 4) continue;
    if (!qLower.includes(phrase)) continue;
    const canonical = CANONICAL_MAP[phrase];
    const hit = CONCEPT_BANK.find((c) => c.canonical === canonical);
    if (!hit) continue;
    if (aliasMatches.some((m) => m.canonical === canonical && m.type === hit.type)) continue;
    if (phraseMatches.some((m) => m.id === hit.id)) continue;
    const isSci = !!SCIENTIFIC_NAME_ALIASES[phrase];
    phraseMatches.push({
      id: hit.id,
      original: titleCase(phrase),
      canonical: hit.canonical,
      type: hit.type,
      scientificName: hit.scientificName || "",
      score: isSci ? 0.95 : 0.85,
      source: "ALIAS_MAP",
      matchType: isSci ? "scientific-name" : "alias"
    });
  }

  try {
    console.log("Understanding query... running semantic search");
    const concepts = await ensureConceptEmbeddings();
    const qVec = await embedText(query);

    const ranked = concepts
      .map((c) => ({
        id: c.id,
        original: c.scientificName || c.canonical,
        canonical: c.canonical,
        type: c.type,
        scientificName: c.scientificName || "",
        score: cosineSimilarity(qVec, c.vector),
        source: "SEMANTIC_SEARCH",
        matchType: "vector"
      }))
      .sort((a, b) => b.score - a.score);

    const vectorMatches = ranked.filter((m) => m.score >= 0.55).slice(0, 6);

    // Merge: alias/scientific first, then vector (dedupe by type|canonical)
    const merged = [];
    const seen = {};
    for (const m of [...aliasMatches, ...phraseMatches, ...vectorMatches]) {
      const key = m.type + "|" + m.canonical.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      merged.push(m);
    }

    console.log(
      "Semantic matches:",
      merged.map((m) => m.canonical + "(" + m.matchType + "/" + m.score.toFixed(2) + ")").join(", ") ||
        "(none)"
    );
    return { matches: merged, queryEmbedding: qVec };
  } catch (err) {
    console.error("Semantic search error:", err.message || err);
    const matches = [...aliasMatches, ...phraseMatches];
    return {
      matches,
      queryEmbedding: null,
      error: "Semantic search failed. Used scientific-name/alias matching."
    };
  }
}

function normalizeEntity(name, type) {
  const original = String(name || "").trim();
  const key = original.toLowerCase().replace(/\s+/g, " ");
  let canonical = CANONICAL_MAP[key];
  let scientificName = "";
  let matchType = "normalization";

  const sci = SCIENTIFIC_NAME_ALIASES[key];
  if (sci) {
    return {
      original,
      canonical: sci.canonical,
      type: safeLabel(type) || sci.type || "Entity",
      scientificName: sci.scientificName || "",
      matchType: "scientific-name"
    };
  }

  if (!canonical) {
    const hit = CONCEPT_BANK.find(
      (c) =>
        c.canonical.toLowerCase() === key ||
        (c.scientificName && c.scientificName.toLowerCase() === key)
    );
    if (hit) {
      canonical = hit.canonical;
      scientificName = hit.scientificName || "";
      matchType = hit.scientificName && hit.scientificName.toLowerCase() === key
        ? "scientific-name"
        : "alias";
    }
  } else {
    const hit = CONCEPT_BANK.find((c) => c.canonical === canonical);
    if (hit) scientificName = hit.scientificName || "";
    matchType = SCIENTIFIC_NAME_ALIASES[key] ? "scientific-name" : "alias";
  }

  if (!canonical) {
    canonical = titleCase(original.replace(/\bplants?\b/gi, "").trim() || original);
    matchType = "llm";
  }

  const safeType = safeLabel(type) || type || "Entity";

  return {
    original,
    canonical,
    type: safeType,
    scientificName,
    matchType
  };
}

function applySemanticIntegration(extracted, semanticMatches) {
  const semanticIntegration = [];
  const nameMap = {};

  function remember(original, canonical) {
    nameMap[String(original).toLowerCase()] = canonical;
    nameMap[String(canonical).toLowerCase()] = canonical;
  }

  function mapName(name) {
    if (!name) return name;
    const key = String(name).toLowerCase().trim();
    if (nameMap[key]) return nameMap[key];
    const n = normalizeEntity(name, "Entity");
    remember(n.original, n.canonical);
    return n.canonical;
  }

  const entities = [];
  const seen = {};

  for (const e of extracted.entities || []) {
    if (!e.name) continue;
    const n = normalizeEntity(e.name, e.type);
    remember(n.original, n.canonical);
    if (n.original.toLowerCase() !== n.canonical.toLowerCase() || n.scientificName) {
      semanticIntegration.push({
        original: n.original,
        canonical: n.canonical,
        type: n.type,
        scientificName: n.scientificName || "",
        via: "normalization",
        matchType: n.matchType || "normalization",
        source: "SEMANTIC_SEARCH"
      });
    }

    const key = n.type + "|" + n.canonical.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;

    entities.push({
      name: n.canonical,
      original: n.original,
      type: n.type,
      scientificName: n.scientificName || "",
      confidence: e.confidence,
      source: e.source === "inference" ? "LLM_INFERENCE" : "USER_QUERY"
    });
  }

  // Merge high-confidence semantic matches Gemini may have missed.
  // Never add a conflicting Soil/Weather concept that contradicts the query context
  // (e.g. Dry Soil into a high-rainfall query) unless Gemini already extracted it.
  const existingCrop = entities.find((e) => e.type === "Crop");
  for (const m of semanticMatches || []) {
    const key = m.type + "|" + m.canonical.toLowerCase();

    if (m.type === "Crop" && existingCrop && existingCrop.name !== m.canonical) {
      if (m.scientificName) {
        semanticIntegration.push({
          original: m.scientificName,
          canonical: m.canonical,
          type: m.type,
          score: m.score,
          via: "semantic_search",
          matchType: m.matchType || "vector",
          source: "SEMANTIC_SEARCH"
        });
      }
      continue;
    }

    // Only auto-add Soil/Weather/Disease from semantic search if score is high
    // AND Gemini did not already provide entities of that type that conflict.
    if ((m.type === "Soil" || m.type === "Weather") && m.score < 0.62) {
      semanticIntegration.push({
        original: m.original || m.scientificName || m.canonical,
        canonical: m.canonical,
        type: m.type,
        score: m.score,
        via: "semantic_search",
        matchType: m.matchType || "vector",
        source: "SEMANTIC_SEARCH"
      });
      continue;
    }

    semanticIntegration.push({
      original: m.original || m.scientificName || m.canonical,
      canonical: m.canonical,
      type: m.type,
      score: m.score,
      via: "semantic_search",
      matchType: m.matchType || "vector",
      source: "SEMANTIC_SEARCH"
    });

    if (seen[key]) continue;
    if (m.score < 0.55 && m.source !== "SEMANTIC_SEARCH_FALLBACK") continue;

    // If Gemini already found a Soil entity, don't add a contradictory soil concept
    if (m.type === "Soil" && entities.some((e) => e.type === "Soil") && !entities.some((e) => e.name === m.canonical)) {
      continue;
    }
    if (m.type === "Weather" && entities.some((e) => e.type === "Weather") && !entities.some((e) => e.name === m.canonical)) {
      // still allow complementary weather (humidity + rainfall) if score high
      if (m.score < 0.64) continue;
    }

    seen[key] = true;
    entities.push({
      name: m.canonical,
      original: m.scientificName || m.canonical,
      type: m.type,
      scientificName: m.scientificName || "",
      confidence: m.score,
      source: "SEMANTIC_SEARCH"
    });
  }

  const possibleDiseases = (extracted.possibleDiseases || []).map((d) => {
    const n = normalizeEntity(d.name, "Disease");
    remember(n.original, n.canonical);
    semanticIntegration.push({
      original: n.original,
      canonical: n.canonical,
      type: "Disease",
      source: "LLM_INFERENCE"
    });
    return {
      name: n.canonical,
      original: n.original,
      confidence: d.confidence,
      reason: d.reason || "",
      source: "LLM_INFERENCE"
    };
  });

  for (const m of semanticMatches || []) {
    if (m.type !== "Disease") continue;
    if (m.score < 0.58) continue;
    if (possibleDiseases.some((d) => d.name.toLowerCase() === m.canonical.toLowerCase())) continue;
    possibleDiseases.push({
      name: m.canonical,
      original: m.canonical,
      confidence: Math.min(0.7, m.score),
      reason: "Semantically related to the farmer query â€” not confirmed",
      source: "SEMANTIC_SEARCH"
    });
  }

  const relationships = (extracted.relationships || []).map((r) => ({
    source: mapName(r.source),
    relation: r.relation,
    target: mapName(r.target)
  }));

  const treatments = (extracted.treatments || []).map((t) => ({
    ...t,
    name: mapName(t.name),
    forDisease: t.forDisease ? mapName(t.forDisease) : ""
  }));

  const insights = { ...(extracted.insights || {}) };
  if (insights.crop) insights.crop = mapName(insights.crop);
  if (insights.symptom) insights.symptom = mapName(insights.symptom);
  if (insights.soil) insights.soil = mapName(insights.soil);
  if (insights.environment) insights.environment = mapName(insights.environment);
  if (insights.possibleProblem) insights.possibleProblem = mapName(insights.possibleProblem);

  // Deduplicate semantic integration rows
  const uniq = [];
  const seenSI = {};
  for (const s of semanticIntegration) {
    const k = (s.original + "|" + s.canonical + "|" + s.type).toLowerCase();
    if (seenSI[k]) continue;
    seenSI[k] = true;
    uniq.push(s);
  }

  return {
    extracted: {
      ...extracted,
      entities,
      possibleDiseases,
      relationships,
      treatments,
      insights
    },
    semanticIntegration: uniq
  };
}

function buildDetected(extracted) {
  const entities = extracted.entities || [];
  const byType = (t) =>
    entities.filter((e) => e.type === t).map((e) => e.name);

  const scientificNames = entities
    .filter((e) => e.type === "Crop" && e.scientificName)
    .map((e) => e.scientificName);

  return {
    crops: byType("Crop"),
    scientificNames: [...new Set(scientificNames)],
    symptoms: byType("Symptom"),
    diseases: (extracted.possibleDiseases || []).map((d) => d.name),
    soil: byType("Soil"),
    weather: byType("Weather"),
    treatments: (extracted.treatments || []).map((t) => t.name).filter(Boolean),
    entities,
    possibleDiseases: extracted.possibleDiseases || []
  };
}

function buildSources(extracted, papers) {
  if (!papers.length) return [];

  const aboutList =
    (extracted.possibleDiseases || []).length > 0
      ? extracted.possibleDiseases.map((d) => d.name)
      : (extracted.entities || [])
          .filter((e) => e.type === "Crop")
          .map((e) => e.name);

  const topics = aboutList.length ? aboutList : ["Agricultural problem"];
  const sources = [];

  topics.forEach((about) => {
    papers.forEach((p) => {
      sources.push({
        about,
        relatedTo: about,
        title: p.title,
        year: p.year,
        url: p.url,
        authors: Array.isArray(p.authors) ? p.authors.join(", ") : p.authors || "",
        source: p.source || "OpenAlex",
        finding: p.abstract
          ? p.abstract.slice(0, 280) + (p.abstract.length > 280 ? "â€¦" : "")
          : "Abstract not available for this work.",
        provenance: "RESEARCH_PAPER"
      });
    });
  });
  return sources;
}

// ---------- Neo4j ----------
let driver = null;
let vectorIndexReady = false;

function getDriver() {
  if (driver) return driver;

  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;

  if (!uri || !user || !password) {
    return null;
  }

  driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  return driver;
}

async function ensureVectorIndex() {
  if (vectorIndexReady) return true;
  const d = getDriver();
  if (!d) return false;
  const session = d.session();
  try {
    await session.run(`
      CREATE VECTOR INDEX research_embedding IF NOT EXISTS
      FOR (p:ResearchPaper) ON (p.embedding)
      OPTIONS {
        indexConfig: {
          \`vector.dimensions\`: ${EMBEDDING_DIM},
          \`vector.similarity_function\`: 'cosine'
        }
      }
    `);
    vectorIndexReady = true;
    console.log("Neo4j vector index ready (research_embedding)");
    return true;
  } catch (err) {
    console.error("Neo4j vector index error:", err.message || err);
    return false;
  } finally {
    await session.close();
  }
}

// ---------- Gemini (backend only) ----------
async function callGeminiWithSdk(prompt, model) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature: 0.2,
      responseMimeType: "application/json"
    }
  });
  return response.text || "";
}

async function callGeminiWithRest(prompt, model) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    model +
    ":generateContent?key=" +
    process.env.GEMINI_API_KEY;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json"
      }
    })
  });

  const bodyText = await res.text();
  if (!res.ok) {
    console.error("Gemini REST error:", bodyText);
    let details = bodyText;
    try {
      details = JSON.parse(bodyText)?.error?.message || bodyText;
    } catch (_) {}
    const err = new Error("Gemini request failed: " + details);
    err.status = res.status;
    throw err;
  }

  const data = JSON.parse(bodyText);
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callGeminiOnce(prompt, model) {
  try {
    return await callGeminiWithSdk(prompt, model);
  } catch (sdkErr) {
    const msg = String(sdkErr.message || sdkErr);
    console.error("Gemini SDK error (" + model + "):", msg);
    // Don't burn another quota call on REST if this is a rate-limit / quota error
    if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("429") || msg.includes("quota")) {
      const err = new Error("Gemini request failed: " + msg);
      err.status = 429;
      throw err;
    }
    console.log("Falling back to Gemini REST for", model);
    return await callGeminiWithRest(prompt, model);
  }
}

async function callGeminiJson(prompt) {
  if (!process.env.GEMINI_API_KEY) {
    const err = new Error("GEMINI_API_KEY is missing.");
    err.code = "MISSING_GEMINI_KEY";
    throw err;
  }

  let raw = "";
  let lastError = null;

  for (const model of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log("Calling Gemini... model=", model, "attempt=", attempt);
        raw = await callGeminiOnce(prompt, model);
        if (raw) {
          console.log("Gemini response received from", model);
          break;
        }
      } catch (err) {
        lastError = err;
        console.error("Gemini error:", err.message || err);
        const msg = String(err.message || "");
        if (msg.includes("high demand") || msg.includes("RESOURCE_EXHAUSTED") || err.status === 503 || err.status === 429) {
          // On quota for this model, skip quickly to the next model
          if (msg.includes("RESOURCE_EXHAUSTED") || err.status === 429) break;
          await sleep(1500 * attempt);
          continue;
        }
        break;
      }
    }
    if (raw) break;
  }

  if (!raw) {
    throw lastError || new Error("Gemini request failed.");
  }

  const cleaned = cleanJson(raw);
  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    console.error("Gemini JSON parse error:", parseErr.message);
    console.error("Gemini raw text:", cleaned.slice(0, 1000));
    const err = new Error("Gemini returned invalid JSON");
    err.details = parseErr.message;
    throw err;
  }
}

async function extractWithGemini(text, papers, semanticMatches) {
  const paperBlock =
    papers.length === 0
      ? "No research papers were retrieved. Do not invent any papers or URLs."
      : papers
          .map(
            (p, i) =>
              `Paper ${i + 1}:
Title: ${p.title}
Year: ${p.year || "unknown"}
Authors: ${(p.authors || []).join(", ") || "unknown"}
URL: ${p.url || "none"}
Abstract: ${p.abstract || "not available"}`
          )
          .join("\n\n");

  const semanticBlock =
    (semanticMatches || [])
      .map(
        (m) =>
          `- ${m.canonical} (${m.type})${m.scientificName ? " / " + m.scientificName : ""} score=${m.score.toFixed(2)}`
      )
      .join("\n") || "(none)";

  const prompt = `You are an agricultural knowledge extraction assistant.

Farmer query:
"""
${text}
"""

Semantically related concepts already found (do NOT invent papers):
${semanticBlock}

Retrieved research evidence from OpenAlex (use ONLY these; do NOT invent titles/URLs):
${paperBlock}

Extract crops, symptoms, possible diseases, soil, weather, treatments, and relationships.
Use POSSIBLY_HAS_DISEASE for uncertain diagnoses â€” never present them as confirmed.
Use ALTERNATIVE_TO if two possible causes are alternatives (e.g. water stress vs nutrient deficiency).
Use DISPUTED_BY only if research abstracts clearly disagree about a treatment.

Return ONLY valid JSON:
{
  "entities": [
    { "name": "Cotton", "type": "Crop", "confidence": 0.95, "source": "user" }
  ],
  "possibleDiseases": [
    { "name": "Water Stress", "confidence": 0.70, "reason": "..." }
  ],
  "relationships": [
    { "source": "Cotton", "relation": "HAS_SYMPTOM", "target": "Leaf Yellowing / Chlorosis" }
  ],
  "treatments": [
    { "name": "", "forDisease": "", "confidence": 0.4, "uncertain": true, "reason": "" }
  ],
  "conflicts": [
    {
      "type": "alternative|contradiction",
      "topic": "...",
      "sourceA": { "claim": "...", "paperTitle": "exact title from list or empty" },
      "sourceB": { "claim": "...", "paperTitle": "exact title from list or empty" },
      "explanation": "..."
    }
  ],
  "uncertainties": [
    { "item": "", "reason": "" }
  ],
  "searchQuery": "short OpenAlex-style search terms",
  "insights": {
    "crop": "",
    "symptom": "",
    "possibleProblem": "",
    "environment": "",
    "soil": "",
    "summary": ""
  }
}

Allowed entity types: Crop, Symptom, Soil, Weather, Disease, Treatment
Allowed relations: HAS_SYMPTOM, GROWS_IN, EXPOSED_TO, POSSIBLY_HAS_DISEASE, TREATED_BY, SUPPORTED_BY, DISPUTED_BY, ALTERNATIVE_TO
Do not create ResearchPaper entities â€” papers are stored separately from OpenAlex.`;

  console.log("Extracting entities and relationships...");
  return callGeminiJson(prompt);
}

async function generateFinalAnswer(payload) {
  console.log("Generating final answer in language:", payload.language || "English");

  const targetLang = payload.language || "English";
  let langInstruction = "Generate the final agricultural answer in clear, simple English suitable for farmers.";
  if (targetLang === "Telugu") {
    langInstruction = "Generate the final agricultural answer in Telugu. Use simple, farmer-friendly Telugu. Preserve important crop names, disease names, scientific names, and treatment names where appropriate. Do not unnecessarily mix English into the answer.";
  } else if (targetLang === "Hindi") {
    langInstruction = "Generate the final agricultural answer in Hindi. Use simple, farmer-friendly Hindi. Preserve important crop names, disease names, scientific names, and treatment names where appropriate.";
  }

  const prompt = `You are an agricultural advisor helping a farmer.

Farmer query:
"""
${payload.query}
"""

Target Output Language: ${targetLang}
Language Instruction: ${langInstruction}

Detected information (JSON):
${JSON.stringify(payload.detected, null, 2)}

Semantic integration:
${JSON.stringify(payload.semanticIntegration, null, 2)}

Research sources from OpenAlex (ONLY these exist — do not invent papers):
${JSON.stringify(payload.sources, null, 2)}

Neo4j vector search hits:
${JSON.stringify(payload.vectorHits, null, 2)}

Graph relationships:
${JSON.stringify(payload.graphRelationships, null, 2)}

Conflicts / alternatives:
${JSON.stringify(payload.conflicts, null, 2)}

Write a clear farmer-facing answer.
Rules:
- ${langInstruction}
- Speak simply to the farmer.
- Distinguish possible/potential causes from confirmed facts.
- Mention conflicting or alternative evidence when present.
- Reference real paper titles from the sources list only.
- Do not invent URLs, DOIs, authors, or paper titles.
- If no research was found, say so clearly.

Return ONLY JSON:
{
  "answer": "multi-paragraph answer for the farmer in the requested language",
  "conflictsSummary": "short note about conflicts or 'No conflicting evidence detected.'"
}`;

  return callGeminiJson(prompt);
}

// ---------- OpenAlex (backend only) ----------
function mapOpenAlexWork(w) {
  const authors = (w.authorships || [])
    .slice(0, 3)
    .map((a) => a?.author?.display_name)
    .filter(Boolean);

  let url = "";
  if (w.primary_location?.landing_page_url) url = w.primary_location.landing_page_url;
  else if (w.open_access?.oa_url) url = w.open_access.oa_url;
  else if (w.doi) url = w.doi;
  else if (w.id) url = w.id;

  const abstract = reconstructAbstract(w.abstract_inverted_index);

  return {
    title: w.display_name || "Untitled",
    year: w.publication_year || null,
    doi: w.doi || "",
    url,
    authors,
    openAlexId: w.id || "",
    abstract,
    source: "OpenAlex"
  };
}

async function searchEuropePmc(query) {
  console.log("Falling back to Europe PMC research search...");
  try {
    const params = new URLSearchParams({
      query: String(query).slice(0, 180),
      format: "json",
      pageSize: "5",
      resultType: "core"
    });
    const res = await fetch(
      "https://www.ebi.ac.uk/europepmc/webservices/rest/search?" + params.toString()
    );
    if (!res.ok) {
      console.error("Research API error: Europe PMC status", res.status);
      return [];
    }
    const data = await res.json();
    const results = data?.resultList?.result || [];
    return results.map((r) => {
      const pmid = r.pmid || "";
      const doi = r.doi || "";
      let url = "";
      if (doi) url = "https://doi.org/" + doi;
      else if (pmid) url = "https://europepmc.org/article/MED/" + pmid;
      else if (r.id) url = "https://europepmc.org/article/" + (r.source || "MED") + "/" + r.id;

      return {
        title: r.title || "Untitled",
        year: r.pubYear ? Number(r.pubYear) : null,
        doi: doi ? "https://doi.org/" + doi : "",
        url,
        authors: r.authorString ? String(r.authorString).split(",").slice(0, 3).map((a) => a.trim()) : [],
        openAlexId: "",
        abstract: (r.abstractText || "").slice(0, 1200),
        source: "EuropePMC"
      };
    });
  } catch (err) {
    console.error("Research API error (Europe PMC):", err.message || err);
    return [];
  }
}

async function searchOpenAlex(query) {
  if (!query || !String(query).trim()) {
    return { papers: [], error: "No relevant research sources found." };
  }

  console.log("Searching external research... query=", query);

  const params = new URLSearchParams({
    search: String(query).slice(0, 180),
    per_page: "5",
    sort: "relevance_score:desc",
    select:
      "id,display_name,publication_year,doi,primary_location,authorships,open_access,abstract_inverted_index"
  });

  // Optional OpenAlex polite pool / API key
  if (process.env.OPENALEX_API_KEY) {
    params.set("api_key", process.env.OPENALEX_API_KEY);
  }

  const url = "https://api.openalex.org/works?" + params.toString();
  const headers = {
    "User-Agent": "AgriKnowledgeGraphMVP/1.0 (mailto:agri-hackathon@example.com)"
  };

  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const body = await res.text();
        console.error("Research API error: OpenAlex status", res.status, body.slice(0, 200));
        await sleep(1500 * attempt);
        continue;
      }
      const data = await res.json();
      const papers = (data.results || []).map(mapOpenAlexWork);
      console.log("Research results received (OpenAlex):", papers.length);
      if (!papers.length) break;
      return { papers, error: null };
    }

    // OpenAlex search cluster often returns 503 for anonymous users â€” use Europe PMC
    const fallback = await searchEuropePmc(query);
    if (fallback.length) {
      console.log("Research results received (Europe PMC fallback):", fallback.length);
      return { papers: fallback, error: null };
    }

    return { papers: [], error: "Research source retrieval failed." };
  } catch (err) {
    console.error("Research API error:", err.message || err);
    const fallback = await searchEuropePmc(query);
    if (fallback.length) {
      return { papers: fallback, error: null };
    }
    return {
      papers: [],
      error: "Research source retrieval failed."
    };
  }
}

// ---------- Neo4j store ----------
async function saveToNeo4j(sessionId, extracted, papers, paperEmbeddings) {
  const d = getDriver();
  if (!d) {
    throw new Error("Neo4j connection failed.");
  }

  console.log("Storing knowledge in Neo4j...");
  const session = d.session();

  try {
    await session.run("MATCH (n {sessionId: $sessionId}) DETACH DELETE n", { sessionId });

    for (const e of extracted.entities || []) {
      if (!e.name || !e.type) continue;
      const label = safeLabel(e.type);
      if (!label) continue;

      await session.run(
        `MERGE (n:${label} {name: $name, sessionId: $sessionId})
         SET n.confidence = $confidence, n.source = $source, n.type = $type,
             n.canonicalName = $canonical, n.original = $original,
             n.scientificName = $scientificName`,
        {
          name: e.name,
          sessionId,
          confidence: e.confidence ?? 0.5,
          source: e.source || "USER_QUERY",
          type: label,
          canonical: e.name,
          original: e.original || e.name,
          scientificName: e.scientificName || ""
        }
      );
    }

    for (const dItem of extracted.possibleDiseases || []) {
      if (!dItem.name) continue;
      await session.run(
        `MERGE (n:Disease {name: $name, sessionId: $sessionId})
         SET n.confidence = $confidence, n.reason = $reason,
             n.source = $source, n.type = 'Disease'`,
        {
          name: dItem.name,
          sessionId,
          confidence: dItem.confidence ?? 0.5,
          reason: dItem.reason || "",
          source: dItem.source || "LLM_INFERENCE"
        }
      );
    }

    for (const t of extracted.treatments || []) {
      if (!t.name) continue;
      await session.run(
        `MERGE (n:Treatment {name: $name, sessionId: $sessionId})
         SET n.confidence = $confidence, n.uncertain = $uncertain,
             n.reason = $reason, n.forDisease = $forDisease,
             n.source = 'LLM_INFERENCE', n.type = 'Treatment'`,
        {
          name: t.name,
          sessionId,
          confidence: t.confidence ?? 0.4,
          uncertain: t.uncertain !== false,
          reason: t.reason || "",
          forDisease: t.forDisease || ""
        }
      );
    }

    for (const r of extracted.relationships || []) {
      if (!r.source || !r.target || !r.relation) continue;
      const rel = safeRel(r.relation);
      if (!rel) {
        console.log("Skipping unsupported relation:", r.relation);
        continue;
      }

      await session.run(
        `MATCH (a {name: $source, sessionId: $sessionId})
         MATCH (b {name: $target, sessionId: $sessionId})
         MERGE (a)-[rel:${rel}]->(b)
         SET rel.sessionId = $sessionId`,
        { source: r.source, target: r.target, sessionId }
      );
    }

    for (const t of extracted.treatments || []) {
      if (!t.name || !t.forDisease) continue;
      await session.run(
        `MATCH (d:Disease {name: $disease, sessionId: $sessionId})
         MATCH (t:Treatment {name: $treatment, sessionId: $sessionId})
         MERGE (d)-[rel:TREATED_BY]->(t)
         SET rel.sessionId = $sessionId`,
        { disease: t.forDisease, treatment: t.name, sessionId }
      );
    }

    // Link crop â†’ possible diseases if missing
    const cropName = extracted.insights?.crop || findEntityName(extracted, "Crop");
    for (const dItem of extracted.possibleDiseases || []) {
      if (!cropName || !dItem.name) continue;
      await session.run(
        `MATCH (c:Crop {name: $crop, sessionId: $sessionId})
         MATCH (d:Disease {name: $disease, sessionId: $sessionId})
         MERGE (c)-[rel:POSSIBLY_HAS_DISEASE]->(d)
         SET rel.sessionId = $sessionId`,
        { crop: cropName, disease: dItem.name, sessionId }
      );
    }

    const diseases = (extracted.possibleDiseases || []).map((x) => x.name).filter(Boolean);

    for (let i = 0; i < papers.length; i++) {
      const p = papers[i];
      if (!p.title) continue;
      const embedding = paperEmbeddings[i] || null;
      const textChunk = [p.title, p.abstract || ""].filter(Boolean).join(". ").slice(0, 1500);

      await session.run(
        `MERGE (p:ResearchPaper {title: $title, sessionId: $sessionId})
         SET p.name = $title, p.url = $url, p.publicationYear = $year, p.doi = $doi,
             p.source = $paperSource, p.openAlexId = $openAlexId,
             p.authors = $authors, p.type = 'ResearchPaper',
             p.text = $text, p.embedding = $embedding`,
        {
          title: p.title,
          sessionId,
          url: p.url || "",
          year: p.year ? neo4j.int(p.year) : null,
          doi: p.doi || "",
          openAlexId: p.openAlexId || "",
          authors: (p.authors || []).join(", "),
          text: textChunk,
          embedding: embedding,
          paperSource: p.source || "OpenAlex"
        }
      );

      if (diseases.length) {
        for (const disease of diseases) {
          await session.run(
            `MATCH (d:Disease {name: $disease, sessionId: $sessionId})
             MATCH (p:ResearchPaper {title: $title, sessionId: $sessionId})
             MERGE (d)-[rel:SUPPORTED_BY]->(p)
             SET rel.sessionId = $sessionId`,
            { disease, title: p.title, sessionId }
          );
        }
      } else if (cropName) {
        await session.run(
          `MATCH (c:Crop {name: $crop, sessionId: $sessionId})
           MATCH (p:ResearchPaper {title: $title, sessionId: $sessionId})
           MERGE (c)-[rel:SUPPORTED_BY]->(p)
           SET rel.sessionId = $sessionId`,
          { crop: cropName, title: p.title, sessionId }
        );
      }

      for (const t of extracted.treatments || []) {
        if (!t.name) continue;
        await session.run(
          `MATCH (t:Treatment {name: $treatment, sessionId: $sessionId})
           MATCH (p:ResearchPaper {title: $title, sessionId: $sessionId})
           MERGE (t)-[rel:SUPPORTED_BY]->(p)
           SET rel.sessionId = $sessionId`,
          { treatment: t.name, title: p.title, sessionId }
        );
      }
    }

    // Apply DISPUTED_BY / ALTERNATIVE_TO from LLM conflicts when paper titles match
    for (const c of extracted.conflicts || []) {
      if (c.type === "contradiction" && c.sourceA?.paperTitle && c.topic) {
        const topic = c.topic;
        const title = c.sourceA.paperTitle;
        const titleB = c.sourceB?.paperTitle;
        if (titleB) {
          await session.run(
            `MATCH (t {name: $topic, sessionId: $sessionId})
             MATCH (p:ResearchPaper {title: $title, sessionId: $sessionId})
             MERGE (t)-[rel:DISPUTED_BY]->(p)
             SET rel.sessionId = $sessionId, rel.note = $note`,
            {
              topic,
              title: titleB,
              sessionId,
              note: c.explanation || "Conflicting research finding"
            }
          );
          await session.run(
            `MATCH (t {name: $topic, sessionId: $sessionId})
             MATCH (p:ResearchPaper {title: $title, sessionId: $sessionId})
             MERGE (t)-[rel:SUPPORTED_BY]->(p)
             SET rel.sessionId = $sessionId`,
            { topic, title, sessionId }
          );
        }
      }
      if (c.type === "alternative" && c.sourceA?.claim && c.sourceB?.claim) {
        const a = normalizeEntity(c.sourceA.claim, "Disease").canonical;
        const b = normalizeEntity(c.sourceB.claim, "Disease").canonical;
        await session.run(
          `MERGE (x:Disease {name: $a, sessionId: $sessionId})
           SET x.type = 'Disease', x.source = coalesce(x.source, 'LLM_INFERENCE')
           MERGE (y:Disease {name: $b, sessionId: $sessionId})
           SET y.type = 'Disease', y.source = coalesce(y.source, 'LLM_INFERENCE')
           MERGE (x)-[rel:ALTERNATIVE_TO]->(y)
           SET rel.sessionId = $sessionId, rel.note = $note`,
          { a, b, sessionId, note: c.explanation || "Alternative possible cause" }
        );
      }
    }
  } finally {
    await session.close();
  }
}


async function neo4jVectorSearch(queryEmbedding, minScore = 0.55) {
  if (!queryEmbedding) return [];

  console.log("Running Neo4j semantic/vector search...");
  const d = getDriver();
  if (!d) return [];

  const session = d.session();
  try {
    const hasIndex = await ensureVectorIndex();
    if (hasIndex) {
      try {
        const result = await session.run(
          `CALL db.index.vector.queryNodes('research_embedding', 8, $embedding)
           YIELD node, score
           WHERE score >= $minScore
           RETURN node.title AS title, node.url AS url, node.publicationYear AS year,
                  node.text AS text, node.source AS source, node.fileName AS fileName,
                  node.parentFile AS parentFile, score
           ORDER BY score DESC`,
          { embedding: queryEmbedding, minScore }
        );
        const hits = result.records.map((r) => ({
          title: r.get("title"),
          url: r.get("url") || "",
          year: r.get("year") != null ? Number(r.get("year")) : null,
          text: (r.get("text") || "").slice(0, 400),
          finding: (r.get("text") || "").slice(0, 280),
          score: Number(r.get("score")),
          source: r.get("source") || "Local PDF",
          fileName: r.get("parentFile") || r.get("fileName") || "",
          provenance: "NEO4J_VECTOR"
        }));
        console.log("Neo4j vector hits:", hits.length);
        return hits;
      } catch (err) {
        console.error("Neo4j vector query error:", err.message || err);
      }
    }

    const result = await session.run(
      `MATCH (p:ResearchPaper)
       WHERE p.embedding IS NOT NULL
       RETURN p.title AS title, p.url AS url, p.publicationYear AS year,
              p.text AS text, p.source AS source, p.fileName AS fileName,
              p.parentFile AS parentFile, p.embedding AS embedding`
    );

    const hits = result.records
      .map((r) => {
        const emb = r.get("embedding");
        return {
          title: r.get("title"),
          url: r.get("url") || "",
          year: r.get("year") != null ? Number(r.get("year")) : null,
          text: (r.get("text") || "").slice(0, 400),
          finding: (r.get("text") || "").slice(0, 280),
          score: cosineSimilarity(queryEmbedding, emb),
          source: r.get("source") || "Local PDF",
          fileName: r.get("parentFile") || r.get("fileName") || "",
          provenance: "NEO4J_EMBEDDING_FALLBACK"
        };
      })
      .filter((h) => h.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    console.log("Neo4j embedding fallback hits:", hits.length);
    return hits;
  } catch (err) {
    console.error("Neo4j vector search error:", err.message || err);
    return [];
  } finally {
    await session.close();
  }
}

async function neo4jConceptTraversal(conceptNames) {
  console.log("Running Neo4j graph traversal on stored knowledge...");
  const d = getDriver();
  if (!d || !conceptNames.length) return { nodes: [], relationships: [], edges: [] };

  const session = d.session();
  try {
    const result = await session.run(
      `MATCH (n)
       WHERE n.name IN $names OR n.canonicalName IN $names
       OPTIONAL MATCH (n)-[r]->(m)
       RETURN n, r, m
       LIMIT 200`,
      { names: conceptNames }
    );

    const nodeMap = {};
    const edges = [];
    const edgeKeys = {};

    for (const record of result.records) {
      const n = record.get("n");
      const r = record.get("r");
      const m = record.get("m");
      if (n) {
        const id = nodeId(n);
        if (!nodeMap[id]) nodeMap[id] = toNode(n);
      }
      if (m) {
        const id = nodeId(m);
        if (!nodeMap[id]) nodeMap[id] = toNode(m);
      }
      if (r && n && m) {
        const key = nodeId(n) + "|" + r.type + "|" + nodeId(m);
        if (!edgeKeys[key]) {
          edgeKeys[key] = true;
          edges.push({
            id: key,
            source: nodeId(n),
            target: nodeId(m),
            relation: r.type
          });
        }
      }
    }

    return {
      nodes: Object.values(nodeMap),
      edges,
      relationships: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.relation,
        relation: e.relation
      }))
    };
  } finally {
    await session.close();
  }
}

function knowledgeIsSufficient(vectorHits, priorGraph) {
  const strongHits = (vectorHits || []).filter((h) => h.score >= 0.62);
  const hasPapers = strongHits.length >= 1;
  const hasRels = (priorGraph?.relationships || []).length >= 2;
  return hasPapers || hasRels;
}

async function graphTraversal(sessionId, cropName) {
  console.log("Running Neo4j graph query for current analysis...");
  const d = getDriver();
  if (!d) throw new Error("Neo4j connection failed.");

  const session = d.session();
  try {
    if (cropName) {
      await session.run(
        `MATCH (c:Crop {name: $crop, sessionId: $sessionId})
         OPTIONAL MATCH path = (c)-[*1..3]-(x)
         WHERE x.sessionId = $sessionId OR x:ResearchPaper
         RETURN count(path) AS paths`,
        { crop: cropName, sessionId }
      );
    }

    const result = await session.run(
      `MATCH (n {sessionId: $sessionId})
       OPTIONAL MATCH (n)-[r]->(m)
       WHERE m.sessionId = $sessionId OR m:ResearchPaper OR r.sessionId = $sessionId
       RETURN n, r, m`,
      { sessionId }
    );

    const nodeMap = {};
    const edges = [];
    const edgeKeys = {};

    for (const record of result.records) {
      const n = record.get("n");
      const r = record.get("r");
      const m = record.get("m");

      if (n) {
        const id = nodeId(n);
        if (!nodeMap[id]) nodeMap[id] = toNode(n);
      }
      if (m) {
        const id = nodeId(m);
        if (!nodeMap[id]) nodeMap[id] = toNode(m);
      }
      if (r && n && m) {
        const key = nodeId(n) + "|" + r.type + "|" + nodeId(m);
        if (!edgeKeys[key]) {
          edgeKeys[key] = true;
          edges.push({
            id: key,
            source: nodeId(n),
            target: nodeId(m),
            relation: r.type
          });
        }
      }
    }

    return {
      nodes: Object.values(nodeMap),
      edges,
      relationships: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.relation,
        relation: e.relation
      }))
    };
  } finally {
    await session.close();
  }
}

function nodeId(node) {
  const props = node.properties;
  const name = props.name || props.title || "Unknown";
  return (node.labels[0] || "Node") + ":" + name;
}

function toNode(node) {
  const props = node.properties;
  const label = node.labels[0] || "Entity";
  const name = props.name || props.title || "Unknown";
  return {
    id: nodeId(node),
    name,
    label: name,
    type: props.type || label,
    confidence: props.confidence != null ? Number(props.confidence) : null,
    source: props.source || (label === "ResearchPaper" ? "Research" : ""),
    reason: props.reason || "",
    url: props.url || "",
    doi: props.doi || "",
    publicationYear: props.publicationYear != null ? Number(props.publicationYear) : null,
    year: props.publicationYear != null ? Number(props.publicationYear) : null,
    authors: props.authors || "",
    original: props.original || "",
    scientificName: props.scientificName || "",
    uncertain: props.uncertain === true,
    text: props.text ? String(props.text).slice(0, 200) : "",
    fileName: props.parentFile || props.fileName || ""
  };
}

function buildConflicts(extracted, papers) {
  const conflicts = [];

  for (const c of extracted.conflicts || []) {
    conflicts.push({
      type: c.type || "alternative",
      topic: c.topic || "",
      sourceA: c.sourceA?.paperTitle || c.sourceA?.claim || c.sourceA || "",
      claimA: c.sourceA?.claim || c.sourceA?.reason || "",
      sourceB: c.sourceB?.paperTitle || c.sourceB?.claim || c.sourceB || "",
      claimB: c.sourceB?.claim || c.sourceB?.reason || "",
      explanation: c.explanation || "",
      note:
        c.type === "contradiction"
          ? "Conflicting evidence detected. Both sources are preserved."
          : "Alternative explanations found. Both are preserved."
    });
  }

  const diseases = extracted.possibleDiseases || [];
  if (diseases.length >= 2 && !conflicts.some((c) => c.type === "alternative")) {
    conflicts.push({
      type: "alternative",
      topic: "Possible causes",
      sourceA: papers[0]?.title || "Detected evidence A",
      claimA: diseases[0].name + (diseases[0].reason ? " — " + diseases[0].reason : ""),
      sourceB: papers[1]?.title || "Detected evidence B",
      claimB: diseases[1].name + (diseases[1].reason ? " — " + diseases[1].reason : ""),
      explanation:
        "More than one possible cause was identified. This is not necessarily a direct contradiction.",
      note: "Alternative possible causes — both preserved."
    });
  }

  return conflicts;
}

function sourcesFromVectorHits(hits) {
  return (hits || []).map((h) => ({
    title: h.title,
    year: h.year,
    url: h.url || "",
    source: h.source || "Local PDF",
    fileName: h.fileName || "",
    finding: h.finding || h.text || "",
    relatedTo: "Retrieved knowledge",
    provenance: h.provenance || "NEO4J_VECTOR",
    score: h.score
  }));
}

function cleanPdfText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/-\n([a-z])/g, "$1") // join hyphenated line breaks
    .trim();
}

function chunkText(text, size = 1400, overlap = 200) {
  const clean = cleanPdfText(text).replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    const piece = clean.slice(i, i + size).trim();
    if (piece.length >= 40) chunks.push(piece);
    i += Math.max(size - overlap, 200);
  }
  return chunks.slice(0, 15);
}

async function extractTextFromResearchFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  console.log("PDF extraction started:", path.basename(filePath));
  if (ext === ".pdf") {
    if (!pdfParse) throw new Error("PDF extraction failed: pdf-parse is not installed.");
    const data = await pdfParse(fs.readFileSync(filePath));
    const text = cleanPdfText(data.text || "");
    console.log("PDF extraction completed. chars=", text.length);
    return text;
  }
  // Plain text research notes are allowed only if placed intentionally in research/
  if (ext === ".txt") {
    return cleanPdfText(fs.readFileSync(filePath, "utf8"));
  }
  throw new Error("Unsupported research file type: " + ext + " (use .pdf)");
}

async function isResearchFileImported(fileName) {
  const d = getDriver();
  if (!d) return false;
  const session = d.session();
  try {
    const result = await session.run(
      `MATCH (p:ResearchPaper {fileName: $fileName})
       RETURN count(p) AS c`,
      { fileName }
    );
    const c = result.records[0]?.get("c");
    return c != null && Number(c) > 0;
  } finally {
    await session.close();
  }
}

async function extractKnowledgeFromPdfText(fileName, chunks) {
  // One Gemini call using concatenated useful chunks (quota-safe)
  const evidenceText = chunks.slice(0, 4).join("\n\n---\n\n").slice(0, 12000);
  const prompt = `You extract agricultural knowledge ONLY from the research text below.
Do NOT invent crops, diseases, treatments, years, URLs, or findings that are not supported by the text.
If uncertain, use possible/may be associated language via POSSIBLY_HAS_DISEASE or ASSOCIATED_WITH.

Research filename: ${fileName}

Research text:
"""
${evidenceText}
"""

Return ONLY valid JSON:
{
  "entities": [
    { "name": "Cotton", "type": "Crop", "scientificName": "Gossypium hirsutum", "confidence": 0.9, "source": "user" }
  ],
  "possibleDiseases": [
    { "name": "Water Stress", "confidence": 0.7, "reason": "supported by text..." }
  ],
  "relationships": [
    { "source": "Cotton", "relation": "HAS_SYMPTOM", "target": "Leaf Yellowing / Chlorosis" }
  ],
  "treatments": [
    { "name": "", "forDisease": "", "confidence": 0.4, "uncertain": true, "reason": "" }
  ],
  "conflicts": [],
  "insights": { "crop": "", "symptom": "", "possibleProblem": "", "soil": "", "environment": "", "summary": "" },
  "searchQuery": ""
}

Allowed entity types: Crop, Symptom, Soil, Weather, Disease, Treatment
Allowed relations: HAS_SYMPTOM, GROWS_IN, EXPOSED_TO, POSSIBLY_HAS_DISEASE, TREATED_BY, SUPPORTED_BY, DISPUTED_BY, ALTERNATIVE_TO, ASSOCIATED_WITH
Do not create ResearchPaper entities.`;

  console.log("Gemini extraction started for", fileName);
  try {
    const raw = await callGeminiJson(prompt);
    console.log("Knowledge extracted from", fileName);
    return raw;
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota")) {
      throw new Error(
        "PDF extraction succeeded, but Gemini knowledge extraction is currently unavailable (quota/rate limit)."
      );
    }
    throw new Error(
      "PDF extraction succeeded, but Gemini knowledge extraction is currently unavailable: " + msg
    );
  }
}

async function storePersistentKnowledge(paperMeta, extracted, chunkEmbeddings) {
  const d = getDriver();
  if (!d) throw new Error("Neo4j connection failed.");
  const session = d.session();
  const kbId = "kb";

  try {
    // Parent ResearchPaper node keyed by filename (provenance root)
    await session.run(
      `MERGE (p:ResearchPaper {fileName: $fileName})
       SET p.name = $title,
           p.title = $title,
           p.url = $url,
           p.publicationYear = $year,
           p.source = $source,
           p.type = 'ResearchPaper',
           p.text = $text,
           p.embedding = $embedding,
           p.kbId = $kbId,
           p.persistent = true,
           p.chunkCount = $chunkCount`,
      {
        fileName: paperMeta.fileName,
        title: paperMeta.title,
        url: paperMeta.url || "",
        year: paperMeta.year ? neo4j.int(paperMeta.year) : null,
        source: paperMeta.source || "Local PDF",
        text: (paperMeta.chunks[0] || "").slice(0, 2000),
        embedding: chunkEmbeddings[0] || null,
        kbId,
        chunkCount: neo4j.int(paperMeta.chunks.length)
      }
    );

    // Optional chunk nodes for finer vector retrieval (still linked to same filename)
    for (let i = 0; i < (paperMeta.chunks || []).length; i++) {
      const chunk = paperMeta.chunks[i];
      const embedding = chunkEmbeddings[i] || null;
      const chunkId = paperMeta.fileName + "#chunk" + (i + 1);
      await session.run(
        `MERGE (c:ResearchPaper {fileName: $chunkId})
         SET c.name = $title,
             c.title = $title,
             c.parentFile = $parentFile,
             c.url = $url,
             c.publicationYear = $year,
             c.source = $source,
             c.type = 'ResearchPaper',
             c.text = $text,
             c.embedding = $embedding,
             c.kbId = $kbId,
             c.persistent = true,
             c.isChunk = true`,
        {
          chunkId,
          title: paperMeta.title + " [chunk " + (i + 1) + "]",
          parentFile: paperMeta.fileName,
          url: paperMeta.url || "",
          year: paperMeta.year ? neo4j.int(paperMeta.year) : null,
          source: paperMeta.source || "Local PDF",
          text: chunk,
          embedding,
          kbId
        }
      );
    }

    for (const e of extracted.entities || []) {
      if (!e.name || !e.type) continue;
      const label = safeLabel(e.type);
      if (!label || label === "ResearchPaper") continue;
      const n = normalizeEntity(e.name, label);
      await session.run(
        `MERGE (n:${label} {name: $name, kbId: $kbId})
         SET n.type = $type, n.source = 'RESEARCH_PAPER', n.persistent = true,
             n.scientificName = coalesce($scientificName, n.scientificName),
             n.original = coalesce(n.original, $original)
         WITH n
         MATCH (p:ResearchPaper {fileName: $fileName})
         MERGE (n)-[:SUPPORTED_BY]->(p)`,
        {
          name: n.canonical,
          kbId,
          type: label,
          scientificName: e.scientificName || n.scientificName || "",
          original: n.original,
          fileName: paperMeta.fileName
        }
      );
    }

    for (const dItem of extracted.possibleDiseases || []) {
      if (!dItem.name) continue;
      const n = normalizeEntity(dItem.name, "Disease");
      await session.run(
        `MERGE (n:Disease {name: $name, kbId: $kbId})
         SET n.type = 'Disease', n.source = 'RESEARCH_PAPER', n.persistent = true,
             n.reason = $reason
         WITH n
         MATCH (p:ResearchPaper {fileName: $fileName})
         MERGE (n)-[:SUPPORTED_BY]->(p)`,
        {
          name: n.canonical,
          kbId,
          reason: dItem.reason || "",
          fileName: paperMeta.fileName
        }
      );
    }

    for (const t of extracted.treatments || []) {
      if (!t.name) continue;
      const n = normalizeEntity(t.name, "Treatment");
      await session.run(
        `MERGE (n:Treatment {name: $name, kbId: $kbId})
         SET n.type = 'Treatment', n.source = 'RESEARCH_PAPER', n.persistent = true,
             n.uncertain = true, n.reason = $reason
         WITH n
         MATCH (p:ResearchPaper {fileName: $fileName})
         MERGE (n)-[:SUPPORTED_BY]->(p)`,
        {
          name: n.canonical,
          kbId,
          reason: t.reason || "",
          fileName: paperMeta.fileName
        }
      );
      if (t.forDisease) {
        const dName = normalizeEntity(t.forDisease, "Disease").canonical;
        await session.run(
          `MATCH (d:Disease {name: $disease, kbId: $kbId})
           MATCH (t:Treatment {name: $treatment, kbId: $kbId})
           MERGE (d)-[:TREATED_BY]->(t)`,
          { disease: dName, treatment: n.canonical, kbId }
        );
      }
    }

    for (const r of extracted.relationships || []) {
      const from = r.source || r.from;
      const to = r.target || r.to;
      if (!from || !to || !r.relation) continue;
      const rel = safeRel(r.relation);
      if (!rel) continue;
      const a = normalizeEntity(from, "Entity").canonical;
      const b = normalizeEntity(to, "Entity").canonical;
      await session.run(
        `MATCH (x {name: $source, kbId: $kbId})
         MATCH (y {name: $target, kbId: $kbId})
         MERGE (x)-[rel:${rel}]->(y)
         SET rel.kbId = $kbId, rel.fileName = $fileName`,
        { source: a, target: b, kbId, fileName: paperMeta.fileName }
      );
    }

    for (const dItem of extracted.possibleDiseases || []) {
      for (const e of extracted.entities || []) {
        if (e.type !== "Symptom" || !dItem.name) continue;
        await session.run(
          `MATCH (s:Symptom {name: $symptom, kbId: $kbId})
           MATCH (d:Disease {name: $disease, kbId: $kbId})
           MERGE (s)-[rel:ASSOCIATED_WITH]->(d)
           SET rel.kbId = $kbId`,
          {
            symptom: normalizeEntity(e.name, "Symptom").canonical,
            disease: normalizeEntity(dItem.name, "Disease").canonical,
            kbId
          }
        );
      }
    }
  } finally {
    await session.close();
  }
}

async function ingestResearchFile(filePath) {
  const fileName = path.basename(filePath);
  console.log("PDF detected:", fileName);

  if (ingestInProgress.has(fileName)) {
    console.log("PDF ingest already in progress, skipping:", fileName);
    return { fileName, skipped: true, reason: "in_progress" };
  }

  if (await isResearchFileImported(fileName)) {
    console.log("PDF already imported, skipping:", fileName);
    return { fileName, skipped: true, reason: "already_imported" };
  }

  ingestInProgress.add(fileName);
  try {
  let rawText;
  try {
    rawText = await extractTextFromResearchFile(filePath);
  } catch (err) {
    console.error("PDF extraction error:", err.message || err);
    throw err;
  }

  if (!rawText || rawText.trim().length < 40) {
    throw new Error("PDF extraction failed: little or no extractable text in " + fileName);
  }

  const chunks = chunkText(rawText);
  console.log("PDF chunks created:", chunks.length);

  // Metadata: never invent. Filename always preserved.
  // Title defaults to filename stem only when PDF has no Title: line.
  const titleMatch = rawText.match(/(?:^|\n)\s*Title\s*[:\-]\s*(.+)/i);
  const yearMatch = rawText.match(/(?:^|\n)\s*Year\s*[:\-]\s*(\d{4})/i);
  const urlMatch = rawText.match(/https?:\/\/[^\s)]+/i);

  const paperMeta = {
    title: (titleMatch && titleMatch[1].trim().slice(0, 300)) || fileName.replace(/\.[^.]+$/, ""),
    year: yearMatch ? Number(yearMatch[1]) : null,
    source: "Local PDF",
    url: urlMatch ? urlMatch[0] : "",
    fileName,
    chunks
  };

  const extractedRaw = await extractKnowledgeFromPdfText(fileName, chunks);
  const { extracted } = applySemanticIntegration(extractedRaw, []);

  console.log("Embedding generated for chunks...");
  const chunkEmbeddings = [];
  for (const chunk of chunks) {
    try {
      chunkEmbeddings.push(await embedText(chunk));
    } catch (err) {
      console.error("Embedding error during ingest:", err.message || err);
      chunkEmbeddings.push(null);
    }
  }

  await ensureVectorIndex();
  console.log("Neo4j storage started for", fileName);
  await storePersistentKnowledge(paperMeta, extracted, chunkEmbeddings);
  console.log("PDF import completed:", fileName, "chunks=", chunks.length);

  return {
    fileName,
    title: paperMeta.title,
    year: paperMeta.year,
    url: paperMeta.url || null,
    chunks: chunks.length,
    entities: (extracted.entities || []).length,
    skipped: false
  };
  } finally {
    ingestInProgress.delete(fileName);
  }
}

async function ingestAllResearchFiles() {
  if (!fs.existsSync(RESEARCH_DIR)) {
    fs.mkdirSync(RESEARCH_DIR, { recursive: true });
    return { ingested: [], skipped: [] };
  }

  // PRIMARY: PDF files only. Ignore README and any leftover seed notes.
  const files = fs
    .readdirSync(RESEARCH_DIR)
    .filter((f) => /\.pdf$/i.test(f));

  const ingested = [];
  const skipped = [];

  for (const f of files) {
    try {
      const result = await ingestResearchFile(path.join(RESEARCH_DIR, f));
      if (result.skipped) skipped.push(result);
      else ingested.push(result);
    } catch (err) {
      console.error("Research ingest error (" + f + "):", err.message || err);
      skipped.push({ fileName: f, skipped: true, error: err.message || String(err) });
    }
  }

  return { ingested, skipped, pdfCount: files.length };
}

// ---------- API ----------
app.post("/api/analyze", async (req, res) => {
  try {
    console.log("Received agricultural query");

    const cleanText = String(req.body.query || req.body.text || "").trim();

    if (!cleanText) {
      return res.status(400).json({ error: "Please describe your agricultural problem." });
    }
    if (cleanText.length < 15) {
      return res.status(400).json({
        error:
          "Please write a fuller sentence so the system can detect crop, symptoms, and conditions."
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is missing." });
    }

    if (!getDriver()) {
      return res.status(500).json({
        error: "Neo4j connection failed. Set NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD in .env"
      });
    }

    let targetLanguage = String(req.body.language || req.body.lang || "English").trim();
    if (/telugu|te/i.test(targetLanguage)) {
      targetLanguage = "Telugu";
    } else if (/hindi|hi/i.test(targetLanguage)) {
      targetLanguage = "Hindi";
    } else {
      targetLanguage = "English";
    }

    // 1) Semantic search + scientific-name alias matching
    const { matches: semanticMatches, queryEmbedding, error: semanticError } =
      await semanticSearch(cleanText);
    if (semanticError) console.error("Semantic search error:", semanticError);

    // 2) Neo4j vector search on stored research (PRIMARY)
    let vectorHits = [];
    try {
      vectorHits = await neo4jVectorSearch(queryEmbedding || (await embedText(cleanText)));
    } catch (vErr) {
      console.error("Neo4j vector search error:", vErr.message || vErr);
    }

    // 3) Neo4j graph traversal on matched concepts
    const conceptNames = semanticMatches.map((m) => m.canonical);
    let priorGraph = { nodes: [], relationships: [], edges: [] };
    try {
      priorGraph = await neo4jConceptTraversal(conceptNames);
    } catch (gErr) {
      console.error("Neo4j graph traversal error:", gErr.message || gErr);
    }

    // 4) OpenAlex ONLY if Neo4j knowledge is insufficient
    let papers = [];
    let openAlexError = null;
    let researchMode = "neo4j";

    const neo4jSources = sourcesFromVectorHits(vectorHits);

    if (!knowledgeIsSufficient(vectorHits, priorGraph)) {
      console.log("Neo4j knowledge insufficient — searching OpenAlex fallback...");
      researchMode = "openalex_fallback";
      const cropTerms = semanticMatches
        .filter((m) => m.type === "Crop")
        .map((m) => m.scientificName || m.canonical);
      const otherTerms = semanticMatches
        .filter((m) => m.type !== "Crop")
        .slice(0, 3)
        .map((m) => m.canonical);
      const openAlexQuery =
        [...cropTerms, ...otherTerms].join(" ") ||
        cleanText
          .replace(/[^\w\s-]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .slice(0, 12)
          .join(" ");

      const oa = await searchOpenAlex(openAlexQuery);
      papers = oa.papers || [];
      openAlexError = oa.error;
      if (openAlexError) console.error("Research API error:", openAlexError);
    } else {
      console.log("Using Neo4j stored research knowledge (skipping OpenAlex)");
      papers = vectorHits.map((h) => ({
        title: h.title,
        year: h.year,
        url: h.url,
        authors: [],
        abstract: h.text,
        source: h.source || "Neo4j"
      }));
    }

    // Evidence passed to Gemini = Neo4j hits + any OpenAlex papers
    const evidencePapers =
      researchMode === "openalex_fallback"
        ? papers
        : papers;

    // 5) Gemini extraction using retrieved evidence
    let rawExtracted;
    try {
      rawExtracted = await extractWithGemini(cleanText, evidencePapers, semanticMatches);
    } catch (gemErr) {
      console.error("Gemini error:", gemErr.message || gemErr);
      return res.status(500).json({
        error: gemErr.message || "Gemini request failed.",
        details: gemErr.details
      });
    }

    // 6) Semantic data integration
    console.log("Applying semantic integration...");
    const { extracted, semanticIntegration } = applySemanticIntegration(
      rawExtracted,
      semanticMatches
    );

    // 7) Embeddings + store current analysis (+ persist OpenAlex papers into Neo4j)
    console.log("Generating/searching embeddings...");
    const paperEmbeddings = [];
    for (const p of papers) {
      try {
        const text = [p.title, p.abstract || p.text || ""].filter(Boolean).join(". ");
        paperEmbeddings.push(await embedText(text));
      } catch (embErr) {
        console.error("Embedding error for paper:", embErr.message || embErr);
        paperEmbeddings.push(null);
      }
    }

    const sessionId = "s_" + Date.now();
    try {
      await ensureVectorIndex();
      await saveToNeo4j(sessionId, extracted, papers, paperEmbeddings);

      // Persist OpenAlex papers into global KB for future Neo4j-first retrieval
      if (researchMode === "openalex_fallback" && papers.length) {
        for (let i = 0; i < papers.length; i++) {
          const p = papers[i];
          await storePersistentKnowledge(
            {
              title: p.title,
              year: p.year,
              source: p.source || "OpenAlex",
              url: p.url || "",
              fileName: "",
              chunks: [[p.title, p.abstract || ""].filter(Boolean).join(". ").slice(0, 1500)].filter(Boolean)
            },
            { entities: [], possibleDiseases: extracted.possibleDiseases || [], relationships: [] },
            [paperEmbeddings[i]]
          );
        }
      }
    } catch (neoErr) {
      console.error("Neo4j error:", neoErr.message || neoErr);
      return res.status(500).json({
        error: "Neo4j connection failed.",
        details: neoErr.message
      });
    }

    // 8) Final Neo4j graph for UI (current analysis + linked papers)
    let graph;
    try {
      const cropName = extracted.insights?.crop || findEntityName(extracted, "Crop");
      graph = await graphTraversal(sessionId, cropName);
    } catch (neoErr) {
      console.error("Neo4j error:", neoErr.message || neoErr);
      return res.status(500).json({
        error: "Neo4j query failed.",
        details: neoErr.message
      });
    }

    // 9) Conflicts
    console.log("Checking conflicts...");
    const conflicts = buildConflicts(extracted, papers);

    const detected = buildDetected(extracted);
    const oaSources = buildSources(extracted, researchMode === "openalex_fallback" ? papers : []);
    const sources = [...neo4jSources, ...oaSources];
    // Deduplicate by title
    const seenTitles = {};
    const uniqueSources = sources.filter((s) => {
      const k = String(s.title || "").toLowerCase();
      if (!k || seenTitles[k]) return false;
      seenTitles[k] = true;
      return true;
    });

    // 10) Final answer
    let answer = "";
    let conflictsSummary = conflicts.length
      ? "Conflicting or alternative evidence detected."
      : "No conflicting evidence detected.";

    try {
      const final = await generateFinalAnswer({
        query: cleanText,
        language: targetLanguage,
        detected,
        semanticIntegration,
        sources: uniqueSources,
        vectorHits,
        graphRelationships: graph.relationships,
        conflicts
      });
      answer = final.answer || "";
      if (final.conflictsSummary) conflictsSummary = final.conflictsSummary;
    } catch (ansErr) {
      console.error("Gemini error (final answer):", ansErr.message || ansErr);
      const crop = detected.crops[0] || "your crop";
      const symptoms = detected.symptoms.join(", ") || "the reported symptoms";
      const soil = detected.soil.join(", ");
      const weather = detected.weather.join(", ");
      const disease = detected.diseases[0];

      if (targetLanguage === "Telugu") {
        answer = `మీ వర్ణన ఆధారంగా, ${crop} లో ${symptoms} గమనించబడింది. దయచేసి పరిశోధన ఆధారాలను పరిశీలించండి.`;
      } else if (targetLanguage === "Hindi") {
        answer = `आपके विवरण के आधार पर, ${crop} में ${symptoms} देखे गए हैं। कृपया उपचार से पहले शोध साक्ष्यों की समीक्षा करें।`;
      } else {
        answer =
          `Based on your description, ${crop} shows ${symptoms}` +
          (soil ? `, with soil conditions including ${soil}` : "") +
          (weather ? `, and weather/environment factors including ${weather}` : "") +
          ". " +
          (disease
            ? `A possible condition may be associated with ${disease} — this is not a confirmed diagnosis. `
            : "") +
          (uniqueSources.length
            ? "Review the retrieved research evidence before treating the crop."
            : openAlexError || "No relevant research sources found.");
      }
    }

    console.log(
      "Analysis completed. mode=",
      researchMode,
      "language=",
      targetLanguage,
      "nodes=",
      graph.nodes.length,
      "edges=",
      graph.edges.length
    );

    res.json({
      query: cleanText,
      language: targetLanguage,
      sessionId,
      answer,
      conflictsSummary,
      researchMode,
      detected,
      semanticIntegration,
      sources: uniqueSources,
      papers,
      papersError:
        uniqueSources.length
          ? null
          : openAlexError || "No relevant research sources found.",
      conflicts,
      vectorHits,
      semanticMatches,
      entities: extracted.entities || [],
      possibleDiseases: extracted.possibleDiseases || [],
      relationships: extracted.relationships || [],
      treatments: extracted.treatments || [],
      uncertainties: extracted.uncertainties || [],
      insights: extracted.insights || {},
      graph
    });
  } catch (err) {
    console.error("Analyze error:", err.message || err);
    if (err.details) console.error("Details:", err.details);

    res.status(500).json({
      error: err.message || "Analysis failed.",
      details: err.details || undefined
    });
  }
});

app.post("/api/ingest-research", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is missing." });
    }
    if (!getDriver()) {
      return res.status(500).json({ error: "Neo4j connection failed." });
    }
    console.log("Starting research PDF/TXT ingest...");
    const result = await ingestAllResearchFiles();
    res.json({
      message: "Research ingest completed",
      ...result
    });
  } catch (err) {
    console.error("Ingest error:", err.message || err);
    res.status(500).json({ error: err.message || "Research ingest failed." });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, async () => {
  console.log("Server running at http://localhost:" + PORT);
  // Auto-ingest local research PDFs/TXT on startup (non-fatal)
  try {
    if (getDriver() && process.env.GEMINI_API_KEY) {
      console.log("Checking research/ folder for PDF/TXT ingest...");
      const result = await ingestAllResearchFiles();
      console.log(
        "Startup ingest done. ingested=",
        result.ingested.length,
        "skipped=",
        result.skipped.length
      );
    }
  } catch (err) {
    console.error("Startup research ingest error:", err.message || err);
  }
});

process.on("exit", async () => {
  if (driver) await driver.close();
});
