// Backend per Pokédex Vault — usa TCGdex (gratis, nessuna API key)
// Avvio: npm install, poi npm start (vedi package.json)

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const TCGDEX_BASE = "https://api.tcgdex.net/v2";
const SUPPORTED_LANGS = ["en", "it", "de", "fr", "es", "ja"];

// Cache semplice in memoria (key -> {data, expires})
const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 ora

async function cachedFetch(url) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.data;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`TCGdex error ${res.status} on ${url}`);
  const data = await res.json();
  cache.set(url, { data, expires: Date.now() + CACHE_TTL_MS });
  return data;
}

function normalizeLang(lang) {
  const l = (lang || "en").toLowerCase();
  return SUPPORTED_LANGS.includes(l) ? l : "en";
}

// Estrae un prezzo "di riferimento" coerente dal blob pricing di TCGdex
// (la struttura varia tra variant: normal/holofoil/reverse ecc.)
function extractPricing(card) {
  const out = { cardmarket: null, tcgplayer: null };
  if (!card?.pricing) return out;

  const cm = card.pricing.cardmarket;
  if (cm) {
    out.cardmarket = {
      currency: "EUR",
      avg: cm.avg ?? cm.avg30 ?? cm.trend ?? null,
      low: cm.low ?? cm.lowPrice ?? null,
      trend: cm.trend ?? null,
      avg7: cm.avg7 ?? null,
      avg30: cm.avg30 ?? null,
      updated: cm.updated ?? null,
    };
  }

  const tp = card.pricing.tcgplayer;
  if (tp) {
    // tcgplayer IS organized per variant (normal/holofoil/reverseHolofoil...)
    const firstVariant = Object.values(tp).find((v) => v && typeof v === "object" && "marketPrice" in v);
    if (firstVariant) {
      out.tcgplayer = {
        currency: "USD",
        market: firstVariant.marketPrice ?? null,
        low: firstVariant.lowPrice ?? null,
        high: firstVariant.highPrice ?? null,
      };
    }
  }

  return out;
}

// GET /api/cards/search?q=charizard&lang=it&pokemon_only=true
app.get("/api/cards/search", async (req, res) => {
  try {
    const lang = normalizeLang(req.query.lang);
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Parametro q (query di ricerca) obbligatorio" });

    // TCGdex supporta filtro per nome via query string ?name=
    const url = `${TCGDEX_BASE}/${lang}/cards?name=${encodeURIComponent(q)}`;
    const results = await cachedFetch(url);

    const filtered = req.query.pokemon_only === "true"
      ? results.filter((c) => !c.category || c.category === "Pokemon")
      : results;

    res.json({ lang, count: filtered.length, results: filtered.slice(0, 40) });
  } catch (err) {
    res.status(502).json({ error: "Errore nel recupero dati da TCGdex", detail: err.message });
  }
});

// GET /api/cards/:id?lang=it   (id formato es. "swsh3-136" o "base1-4")
app.get("/api/cards/:id", async (req, res) => {
  try {
    const lang = normalizeLang(req.query.lang);
    const url = `${TCGDEX_BASE}/${lang}/cards/${req.params.id}`;
    const card = await cachedFetch(url);
    res.json({ ...card, normalizedPricing: extractPricing(card) });
  } catch (err) {
    res.status(404).json({ error: "Carta non trovata", detail: err.message });
  }
});

// GET /api/cards/:id/languages   -> stesso ID per ogni lingua disponibile, con prezzo
app.get("/api/cards/:id/languages", async (req, res) => {
  const id = req.params.id;
  const out = {};
  await Promise.all(
    SUPPORTED_LANGS.map(async (lang) => {
      try {
        const card = await cachedFetch(`${TCGDEX_BASE}/${lang}/cards/${id}`);
        out[lang] = { name: card.name, pricing: extractPricing(card) };
      } catch {
        out[lang] = null; // non disponibile in questa lingua
      }
    })
  );
  res.json({ id, languages: out });
});

// GET /api/sets?lang=it
app.get("/api/sets", async (req, res) => {
  try {
    const lang = normalizeLang(req.query.lang);
    const sets = await cachedFetch(`${TCGDEX_BASE}/${lang}/sets`);
    res.json({ lang, sets });
  } catch (err) {
    res.status(502).json({ error: "Errore nel recupero set da TCGdex", detail: err.message });
  }
});

// GET /api/sets/:id?lang=it  -> dettaglio set con elenco carte
app.get("/api/sets/:id", async (req, res) => {
  try {
    const lang = normalizeLang(req.query.lang);
    const set = await cachedFetch(`${TCGDEX_BASE}/${lang}/sets/${req.params.id}`);
    res.json(set);
  } catch (err) {
    res.status(404).json({ error: "Set non trovato", detail: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Pokédex Vault backend attivo su http://localhost:${PORT}`));
