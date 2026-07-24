# Kaapelitehdas RSS

Generoi kaksi epävirallista RSS-syötettä Kaapelitehtaan sivustolta:

- `docs/uutiset.xml` ← https://www.kaapelitehdas.fi/uutisia
- `docs/tapahtumat.xml` ← https://www.kaapelitehdas.fi/tapahtumat

GitHub Actions ajaa skriptin automaattisesti muutaman tunnin välein, committaa
päivittyneet XML-tiedostot repoon ja GitHub Pages tarjoilee ne julkisina
URLeina.

## Miksi tämä ei ole ihan triviaali scraus

Kaapelitehdas.fi on Gatsby-sivusto, mutta uutis- ja tapahtumalistaukset
haetaan selaimessa JavaScriptillä sivun latauduttua (raakassa HTML:ssä lukee
kirjaimellisesti "Ladataan..."). Tavallinen `fetch()` ei siis riitä
listaussivuille — tarvitaan oikea selainmoottori (tässä Playwright +
Chromium), joka suorittaa JS:n ja odottaa sisällön latautumista.

Yksittäiset uutis-/tapahtumasivut (esim. `/artikkelit/jokin-uutinen/` tai
`/tapahtumat/jokin-tapahtuma/`) sen sijaan tuovat otsikon, kuvauksen ja
kansikuvan valmiiksi `<head>`-metatageina, joten niitä varten riittää
tavallinen `fetch`.

**Tunnettu rajoite:** en löytänyt sivustolta luotettavaa julkaisu- tai
tapahtumapäivämäärää, jota voisi lukea automaattisesti. Siksi jokainen
RSS-kohde saa `pubDate`-arvokseen ajon suoritushetken — järjestys pysyy siis
"uusin lisätty ensin" -periaatteella, mutta itse päivämäärä ei kerro
todellista julkaisu-/tapahtuma-ajankohtaa. Jos huomaat sivulla (renderöitynä
selaimessa) elementin, josta päivämäärän voisi poimia, kerro Claudelle niin
`scripts/build-feeds.mjs`-tiedostoa voi tarkentaa.

## Käyttöönotto

1. **Luo uusi GitHub-repo** (esim. `kaapelitehdas-rss`) ja lataa tämän
   projektin tiedostot sinne (`git init`, `git add .`, `git commit`,
   `git push`).

2. **Ota GitHub Pages käyttöön:**
   - Repo → Settings → Pages
   - Source: "Deploy from a branch"
   - Branch: `main`, kansio: `/docs`
   - Tallenna. Pages-osoite näkyy hetken kuluttua muodossa
     `https://<käyttäjänimi>.github.io/<repo-nimi>/`

3. **Tarkista Actions-oikeudet:**
   - Repo → Settings → Actions → General → "Workflow permissions"
   - Valitse "Read and write permissions" (workflow committaa tiedostoja
     takaisin repoon).

4. **Käynnistä ensimmäinen ajo käsin:**
   - Repo → Actions → "Päivitä RSS-syötteet" → "Run workflow"
   - Kun ajo on valmis, `docs/uutiset.xml` ja `docs/tapahtumat.xml` ilmestyvät
     repoon ja hetken päästä myös Pages-osoitteeseen:
     - `https://<käyttäjänimi>.github.io/<repo-nimi>/uutiset.xml`
     - `https://<käyttäjänimi>.github.io/<repo-nimi>/tapahtumat.xml`

5. Lisää nämä kaksi URLia haluamaasi RSS-lukijaan.

Sen jälkeen workflow ajaa itsestään 6 tunnin välein (`cron: "15 */6 * * *"`
`.github/workflows/build-feeds.yml`-tiedostossa) — muokkaa aikataulua sieltä
tarvittaessa.

## Paikallinen testaus

```bash
npm install
npx playwright install --with-deps chromium
npm run build
```

Tulostaa lokiin löydetyt linkit ja kirjoittaa `docs/uutiset.xml` +
`docs/tapahtumat.xml`.

## Jos listaus ei löydä yhtään kohdetta

Sivuston rakenne (linkkien polut, latautumisen kesto) voi muuttua. Tarkista
tällöin `scripts/build-feeds.mjs`-tiedostosta:

- `linkPattern` per lähde — vastaako se yhä yksittäisten sivujen
  URL-muotoa?
- `getRenderedLinks`-funktion `waitUntil`/`waitForTimeout` — tarvitseeko
  sivusto pidemmän odotuksen ennen kuin sisältö on renderöity?

Näet helpoiten oikeat valinnat avaamalla sivun selaimessa, odottamalla että
"Ladataan..." vaihtuu oikeaksi sisällöksi, ja tarkastelemalla DOM:ia
kehittäjätyökaluilla (F12 → Elements).
