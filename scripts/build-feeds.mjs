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
// HUOM: Sivusto ei tällä hetkellä näytä tarjoavan luotettavaa julkaisu-
// päivämäärää listaus- tai yksittäissivuilla. Tämän vuoksi jokainen RSS-
// kohde saa pubDate-arvoksi ajon suoritushetken, JOS sivulta ei löydy
// mitään date-metatietoa. Jos huomaat sivulla julkaisupäivän (esim. jonkin
// elementin sisällä), kerro Claudelle, niin skriptiä voi tarkentaa.

import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { Feed } from "feed";
import fs from "fs";
import path from "path";

const SITE = "https://www.kaapelitehdas.fi";

const SOURCES = [
  {
    key: "uutiset",
    listUrl: `${SITE}/uutisia`,
    // Yksittäiset uutisartikkelit näyttävät elävän polussa /artikkelit/...
    linkPattern: /\/artikkelit\/[^/]+\/?$/,
    title: "Kaapelitehdas – Uutiset",
    description: "Kaapelitehtaan uusimmat uutiset (epävirallinen RSS-syöte)",
  },
  {
    key: "tapahtumat",
    listUrl: `${SITE}/tapahtumat`,
    // Yksittäiset tapahtumat elävät polussa /tapahtumat/<slug>/
    linkPattern: /\/tapahtumat\/[^/]+\/?$/,
    title: "Kaapelitehdas – Tapahtumat",
    description: "Kaapelitehtaan tulevat tapahtumat (epävirallinen RSS-syöte)",
  },
];

// Polkuja, jotka eivät ole yksittäisiä sisältösivuja vaikka osuvat pattern-
// filtteriin (esim. itse listaussivu tai "ilmoita tapahtuma" -lomake).
const EXCLUDE_SUFFIXES = ["/tapahtumat", "/tapahtumat/", "/uutisia", "/uutisia/", "/ilmoita-tapahtuma", "/ilmoita-tapahtuma/"];

async function getRenderedLinks(page, url, pattern) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  // Varmuuden vuoksi pieni lisäodotus, jos data haetaan useammassa vaiheessa.
  await page.waitForTimeout(2500);

  const hrefs = await page.$$eval("a[href]", (as) =>
    as.map((a) => a.getAttribute("href"))
  );

  const abs = hrefs
    .filter(Boolean)
    .map((h) => (h.startsWith("http") ? h : `${SITE}${h.startsWith("/") ? "" : "/"}${h}`))
    .filter((h) => pattern.test(h))
    .filter((h) => !EXCLUDE_SUFFIXES.some((suf) => h.endsWith(suf)));

  return [...new Set(abs)];
}

async function fetchDetail(url) {
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

  return { url, title: title.trim(), description: description.trim(), image };
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
    feed.addItem({
      title: item.title,
      id: item.url,
      link: item.url,
      description: item.description,
      date: new Date(),
      image: item.image || undefined,
    });
  }

  return feed;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  fs.mkdirSync("docs", { recursive: true });

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

    const items = [];
    for (const link of links) {
      try {
        const detail = await fetchDetail(link);
        items.push(detail);
        console.log(`  + ${detail.title}`);
      } catch (e) {
        console.warn(`  - Ohitettu (${link}): ${e.message}`);
      }
    }

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

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
