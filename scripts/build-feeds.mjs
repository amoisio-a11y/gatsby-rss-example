// build-feeds.mjs
//
// Kaapelitehdas.fi on Gatsby-sivusto, jossa uutis- ja tapahtumalistaukset
// haetaan selaimessa JavaScriptillä ("Ladataan..." näkyy raakana HTML:ssä).
// Siksi listaussivut pitää renderöidä oikealla selainmoottorilla (Playwright),
// pelkkä fetch() ei riitä niihin.
//
// Yksittäiset uutis-/tapahtumasivut (esim. /artikkelit/jokin-uutinen/ tai
// /tapahtumat/jokin-tapahtuma/) sen sijaan sisältävät valmiiksi renderöidyt
// meta-tagit (og:title, description, og:image) suoraan HTML:n <head>-osassa,
// joten niitä varten riittää tavallinen fetch + cheerio.
//
// Päivämäärät: sivusto ei tarjoa julkaisupäivää meta-tageissa, mutta
// listaussivuilla (renderöitynä) jokaisen kortin yhteydessä näkyy päivämäärä
// muodossa pp.kk.vvvv (esim. "10.12.2025"). getRenderedLinks poimii tämän
// tekstin jokaisen linkin läheltä DOM:ista kiipeämällä muutaman
// vanhempielementin verran ylöspäin, kunnes löytää pp.kk.vvvv-muotoisen
// merkkijonon. Jos päivämäärää ei löydy, käytetään ajon suoritushetkeä
// varasuunnitelmana.
//
// PUBDATE JA TULEVAISUUDEN TAPAHTUMAT
// ------------------------------------
// "tapahtumat"-lähteen omat päivämäärät ovat usein TULEVAISUUDESSA.
// Jos niitä käytettäisiin suoraan feedin pubDate-kenttänä, moni RSS-lukija
// tulkitsee tulevan päivämäärän niin, että kohde näyttää "juuri nyt"
// -tuoreelta aina siihen asti kunnes päivä koittaa — jolloin tulevat
// tapahtumat floodaavat feedin kärjen pysyvästi.
//
// Siksi lähteille, joilla on useFirstSeenDate: true (tällä hetkellä vain
// "tapahtumat"), pubDate ei ole tapahtuman oma kalenteripäivä vaan
// ajanhetki, jolloin scraperi näki kyseisen URL:n ENSIMMÄISTÄ KERTAA.
// Tämä tallennetaan feed-state.json-tiedostoon ja luetaan/päivitetään
// joka ajolla. Tapahtuman todellinen päivämäärä näkyy silti kuvauksessa.
// "uutiset"-lähde käyttää edelleen artikkelin omaa (jo mennyttä)
// julkaisupäivää sellaisenaan, koska sille ei ole flood-ongelmaa.

import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { Feed } from "feed";
import fs from "fs";
import path from "path";

const SITE = "https://www.kaapelitehdas.fi";
const STATE_FILE = "feed-state.json";

const SOURCES = [
  {
    key: "uutiset",
    listUrl: `${SITE}/uutisia`,
    // Yksittäiset uutisartikkelit näyttävät elävän polussa /artikkelit/...
    linkPattern: /\/artikkelit\/[^/]+\/?$/,
    title: "Kaapelitehdas – Uutiset",
    description: "Kaapelitehtaan uusimmat uutiset (epävirallinen RSS-syöte)",
    useFirstSeenDate: false,
  },
  {
    key: "tapahtumat",
    listUrl: `${SITE}/tapahtumat`,
    // Yksittäiset tapahtumat elävät polussa /tapahtumat/<slug>/
    linkPattern: /\/tapahtumat\/[^/]+\/?$/,
    title: "Kaapelitehdas – Tapahtumat",
    description: "Kaapelitehtaan tulevat tapahtumat (epävirallinen RSS-syöte)",
    useFirstSeenDate: true,
  },
];

// Polkuja, jotka eivät ole yksittäisiä sisältösivuja vaikka osuvat pattern-
// filtteriin (esim. itse listaussivu tai "ilmoita tapahtuma" -lomake).
const EXCLUDE_SUFFIXES = ["/tapahtumat", "/tapahtumat/", "/uutisia", "/uutisia/", "/ilmoita-tapahtuma", "/ilmoita-tapahtuma/"];

// Muuntaa "10.12.2025" -> Date-olio (paikallinen aika, klo 00:00).
function parseFinnishDate(text) {
  const m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  const [, day, month, year] = m;
  const d = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(d.getTime()) ? null : d;
}

// --- State-tiedoston kasittely (ensi kertaa nahty -aikaleimat) ---

function loadState(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    // Tiedostoa ei ole viela tai se on vioittunut -> aloitetaan tyhjasta.
    return {};
  }
}

function saveState(filePath, state) {
  const sortedKeys = Object.keys(state).sort();
  const sorted = {};
  for (const key of sortedKeys) sorted[key] = state[key];
  fs.writeFileSync(filePath, JSON.stringify(sorted, null, 2), "utf-8");
}

/**
 * Palauttaa uuden state-osion (vain source.key:n alla) VAIN nyt
 * loydetyista URL:eista - jo poistuneiden (menneiden) tapahtumien
 * merkinnat eivat siis kasva tiedostoa loputtomiin.
 *
 * items: [{ url, date, ... }]
 * existingSourceState: { [url]: isoString }
 * runTime: Date
 *
 * Palauttaa: { newSourceState, itemsWithPubDate }
 */
function assignFirstSeenDates(items, existingSourceState, runTime) {
  const newSourceState = {};
  const itemsWithPubDate = items.map((item) => {
    const existing = existingSourceState[item.url];
    let firstSeen;
    if (existing) {
      const parsed = new Date(existing);
      firstSeen = Number.isNaN(parsed.getTime()) ? runTime : parsed;
    } else {
      firstSeen = runTime;
    }
    newSourceState[item.url] = firstSeen.toISOString();
    // originalDate sailytetaan kuvausta varten, pubDate-kenttana kaytetaan
    // firstSeen-ajanhetkea.
    return { ...item, originalDate: item.date, date: firstSeen };
  });
  return { newSourceState, itemsWithPubDate };
}

async function getRenderedLinks(page, url, pattern) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  // Varmuuden vuoksi pieni lisäodotus, jos data haetaan useammassa vaiheessa.
  await page.waitForTimeout(2500);

  // Kerätään jokaiselle osuvalle linkille myös lähin pp.kk.vvvv-muotoinen
  // päivämääräteksti, joka löytyy kiipeämällä enintään 6 vanhempi-
  // elementtiä ylöspäin linkistä. Tämä toimii, kun sivusto näyttää
  // päivämäärän samassa "kortissa" kuin otsikon/linkin.
  const raw = await page.evaluate(() => {
    const dateRe = /(\d{1,2})\.(\d{1,2})\.(\d{4})/;
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    return anchors.map((a) => {
      let node = a;
      let dateText = null;
      for (let i = 0; i < 6 && node; i++) {
        const text = node.textContent || "";
        const match = text.match(dateRe);
        if (match) {
          dateText = match[0];
          break;
        }
        node = node.parentElement;
      }
      return { href: a.getAttribute("href"), dateText };
    });
  });

  const byHref = new Map();
  for (const { href, dateText } of raw) {
    if (!href) continue;
    const abs = href.startsWith("http")
      ? href
      : `${SITE}${href.startsWith("/") ? "" : "/"}${href}`;
    if (!pattern.test(abs)) continue;
    if (EXCLUDE_SUFFIXES.some((suf) => abs.endsWith(suf))) continue;
    // Jos sama linkki löytyy useasti, säilytetään ensimmäinen löydetty
    // päivämäärä (yleensä lähempänä linkkiä = luotettavampi).
    if (!byHref.has(abs) || (!byHref.get(abs).dateText && dateText)) {
      byHref.set(abs, { href: abs, date: dateText ? parseFinnishDate(dateText) : null });
    }
  }

  return [...byHref.values()];
}

async function fetchDetail(url, listDate) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KaapelitehdasRSSBot/1.0)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr("content") ||
    $("title").text().trim() ||
    url;

  const description =
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    "";

  const image = $('meta[property="og:image"]').attr("content") || null;

  // Yritetään vielä varmuuden vuoksi löytää päivämäärä myös itse
  // yksittäissivun HTML:stä, jos listaussivulta ei sitä löytynyt
  // (yksittäissivut ovat osittain staattisesti renderöityjä).
  let date = listDate || null;
  if (!date) {
    const bodyText = $("body").text();
    const m = bodyText.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) {
      const [, day, month, year] = m;
      const d = new Date(Number(year), Number(month) - 1, Number(day));
      if (!Number.isNaN(d.getTime())) date = d;
    }
  }

  return { url, title: title.trim(), description: description.trim(), image, date };
}

function buildFeed(source, items) {
  const feed = new Feed({
    title: source.title,
    description: source.description,
    id: source.listUrl,
    link: source.listUrl,
    language: "fi",
    updated: new Date(),
    generator: "kaapelitehdas-rss (GitHub Actions, epävirallinen)",
  });

  for (const item of items) {
    // Jos taman lahteen kaytetaan first-seen-paivamaaraa, kirjoitetaan
    // tapahtuman oma (todellinen) paivamaara kuvaukseen naa aikaisemmin.
    let description = item.description;
    if (source.useFirstSeenDate && item.originalDate) {
      const dateStr = item.originalDate.toLocaleDateString("fi-FI");
      description = description
        ? `Tapahtuman ajankohta: ${dateStr}. ${description}`
        : `Tapahtuman ajankohta: ${dateStr}.`;
    }

    feed.addItem({
      title: item.title,
      id: item.url,
      link: item.url,
      description,
      date: item.date || new Date(),
      image: item.image || undefined,
    });
  }

  return feed;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  fs.mkdirSync("docs", { recursive: true });

  const fullState = loadState(STATE_FILE);
  const runTime = new Date();

  for (const source of SOURCES) {
    console.log(`\n== ${source.key} ==`);
    console.log(`Renderöidään: ${source.listUrl}`);

    let links = [];
    try {
      links = await getRenderedLinks(page, source.listUrl, source.linkPattern);
    } catch (e) {
      console.error(`  Listaussivun renderöinti epäonnistui: ${e.message}`);
    }
    console.log(`  Löytyi ${links.length} kohdelinkkiä`);

    let items = [];
    for (const { href, date } of links) {
      try {
        const detail = await fetchDetail(href, date);
        items.push(detail);
        console.log(
          `  + ${detail.title} (${detail.date ? detail.date.toLocaleDateString("fi-FI") : "ei päivämäärää"})`
        );
      } catch (e) {
        console.warn(`  - Ohitettu (${href}): ${e.message}`);
      }
    }

    if (source.useFirstSeenDate) {
      const existingSourceState = fullState[source.key] || {};
      const { newSourceState, itemsWithPubDate } = assignFirstSeenDates(
        items,
        existingSourceState,
        runTime
      );
      fullState[source.key] = newSourceState;
      items = itemsWithPubDate;

      const newCount = items.filter((i) => !(i.url in existingSourceState)).length;
      console.log(`  (${newCount} uutta tapahtumaa, loput sailyttavat aiemman aikaleimansa)`);
    }

    // Uusimmat ensin.
    items.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));

    if (items.length === 0) {
      console.warn(
        `  VAROITUS: yhtään kohdetta ei löytynyt. Sivuston rakenne on voinut muuttua ` +
          `— tarkista linkPattern ja getRenderedLinks-funktion valinnat.`
      );
    }

    const feed = buildFeed(source, items);
    const outPath = path.join("docs", `${source.key}.xml`);
    fs.writeFileSync(outPath, feed.rss2());
    console.log(`  Kirjoitettu: ${outPath}`);
  }

  saveState(STATE_FILE, fullState);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export { assignFirstSeenDates, loadState, saveState, parseFinnishDate };
