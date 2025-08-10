// parallel-hold-bot.js
import puppeteer from 'puppeteer';
import { Cluster } from 'puppeteer-cluster';
import fs from 'fs';

//
// === Config general ===
//
const URL_START =
  'https://billets.piknicelectronik.com/mul/#/9f24db2b-b12e-455c-8011-98ac07b417d8/shop/custom-pack?_gl=1*c2s6dz*_up*MQ..*_ga*MTU3NjQ4MzEwNS4xNzU0ODM2NzY5*_ga_LPR5RE6Y12*czE3NTQ4MzY3NjkkbzEkZzAkdDE3NTQ4MzY3NjkkajYwJGwwJGg0MDU2MTAzNDA.&fac=PIKNIC&locale=en-CA&skin=offpiknic';

const SEL_CUSTOM_PACK_BTN =
  '#custom-pack__event-details-OFF250919 > div > div.custom-pack__list-item-button-container.col-md-3 > div.custom-pack__list-item-button > div > button';

const SEL_INSIDE_PAGE_CLICK =
  '#ticket-search-page__sidebar-column > div > div > div > div:nth-child(3) > div > div > div.module__container > div > span:nth-child(2) > div > div > div';

const SEL_PLUS_BUTTON =
  '#ticket-search-page__sidebar-column > div > div > div > div.module.module--number-of-tickets.module--bordered > div.module__container > div.number-selector-fancy > button.number-selector-fancy__button.number-selector-fancy__button__plus.btn.btn-icon';

const SEL_NEXT_BUTTON = '#ticket-search-button';
const SEL_REVIEW_BTN = '#order-summary__next__btn--review';
const SEL_FINAL_CART_BTN = '#cart-summary-action-button';

// Opcional: cookie banner (si aparece)
const SEL_COOKIE_BUTTON =
  '#klaro-cookie-notice > div > div > div > button.cm-btn.cm-btn-success';

// Opcional: saltar sold-out antes de entrar
const CONTAINER_SELECTOR =
  '#ticket-search-page__sidebar-column > div > div > div > div:nth-child(3) > div > div > div.module__container > div > span:nth-child(2) > div > div > div';
const SOLD_OUT_CHILD = '.price-level__label--availability--sold-out';

const TICKETS_PER_PACK = 6;

// Concurrencia y hold
const INSTANCES = Number(process.env.INSTANCES || '12'); // cuántas en paralelo
const HOLD_MS = Number(process.env.HOLD_MS || 9.5 * 60_000); // ~9m30s (ajusta)

//
// === Estado global y persistencia simple ===
//
let totalPacksHeld = 0;
let totalTicketsHeld = 0;

function saveProgress(event) {
  const file = 'holds.json';
  let data = { totalPacksHeld, totalTicketsHeld, events: [] };
  try {
    if (fs.existsSync(file)) {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch {
    /* noop */
  }

  if (event) data.events.push({ ts: new Date().toISOString(), ...event });
  data.totalPacksHeld = totalPacksHeld;
  data.totalTicketsHeld = totalTicketsHeld;

  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

//
// === Helpers sin sleeps ciegos ===
//
async function waitForOne(
  page,
  selectors,
  { visible = true, timeout = 60000 } = {}
) {
  const races = selectors.map((sel) =>
    page
      .waitForSelector(sel, { visible, timeout })
      .then(() => sel)
      .catch(() => null)
  );
  const winner = await Promise.race(races);
  if (winner) return winner;
  const results = await Promise.allSettled(races);
  const ok = results.find((r) => r.status === 'fulfilled');
  if (!ok)
    throw new Error(`Ningún selector apareció: ${selectors.join(' | ')}`);
  return winner;
}

async function clickThenWait(
  page,
  clickSelector,
  { nextSelectors = [], navWait = true, timeout = 60000 } = {}
) {
  await page.waitForSelector(clickSelector, { visible: true, timeout });
  const waits = [];
  if (navWait) {
    waits.push(
      page
        .waitForNavigation({ waitUntil: 'networkidle2', timeout })
        .catch(() => null)
    );
  }
  if (nextSelectors.length) {
    waits.push(
      waitForOne(page, nextSelectors, { visible: true, timeout }).catch(
        () => null
      )
    );
  }
  await Promise.allSettled([page.click(clickSelector)]);
  if (waits.length) await Promise.race(waits);
}

async function waitForEnabled(page, selector, timeout = 60000) {
  await page.waitForSelector(selector, { visible: true, timeout });
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const cs = getComputedStyle(el);
      const aria = el.getAttribute('aria-disabled');
      const disabledAttr = el.hasAttribute('disabled');
      const propDis = 'disabled' in el && el.disabled === true;
      const disabled = propDis || disabledAttr || aria === 'true';
      const clickable =
        cs.visibility !== 'hidden' &&
        cs.display !== 'none' &&
        cs.pointerEvents !== 'none' &&
        parseFloat(cs.opacity || '1') > 0.01;
      return !disabled && clickable;
    },
    { timeout },
    selector
  );
}

async function clickIfPresent(page, selector) {
  const el = await page.$(selector);
  if (el) {
    try {
      await el.click();
      return true;
    } catch {}
  }
  return false;
}

//
// === Tarea por instancia ===
//
async function runFlow(page, idx) {
  // 1) Landing
  await page.goto(URL_START, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });

  // 2) Custom pack -> esperar algo de la interna
  await clickThenWait(page, SEL_CUSTOM_PACK_BTN, {
    nextSelectors: [SEL_INSIDE_PAGE_CLICK, SEL_PLUS_BUTTON, SEL_NEXT_BUTTON],
    navWait: true,
    timeout: 90000,
  });

  // (Opcional) saltar si sold-out detectado
  try {
    await page.waitForSelector(CONTAINER_SELECTOR, {
      visible: true,
      timeout: 15000,
    });
    const isSoldOut =
      (await page.$(`${CONTAINER_SELECTOR} ${SOLD_OUT_CHILD}`)) !== null;
    if (isSoldOut) {
      console.log(`inst${idx}: sold-out, sin reservar`);
      return { held: false };
    }
  } catch {
    /* si no aparece el contenedor, seguimos con el flujo normal */
  }

  // 3) Asegurar sección interna
  await page.waitForSelector(SEL_INSIDE_PAGE_CLICK, {
    visible: true,
    timeout: 60000,
  });

  // 4) Sumar 6
  await page.waitForSelector(SEL_PLUS_BUTTON, {
    visible: true,
    timeout: 60000,
  });
  for (let i = 0; i < TICKETS_PER_PACK; i++) {
    await page.click(SEL_PLUS_BUTTON);
  }

  // Cookie banner opcional
  await clickIfPresent(page, SEL_COOKIE_BUTTON);

  // 5) Click interno -> esperar botón NEXT
  await clickThenWait(page, SEL_INSIDE_PAGE_CLICK, {
    nextSelectors: [SEL_NEXT_BUTTON],
    navWait: false,
    timeout: 60000,
  });

  await waitForEnabled(page, SEL_NEXT_BUTTON);
  await clickThenWait(page, SEL_NEXT_BUTTON, {
    nextSelectors: [SEL_REVIEW_BTN],
    navWait: true,
    timeout: 90000,
  });

  // 6) Review
  await clickThenWait(page, SEL_REVIEW_BTN, {
    nextSelectors: [SEL_FINAL_CART_BTN],
    navWait: true,
    timeout: 90000,
  });

  // 7) Cart final (consideramos “hold” conseguido aquí)
  await waitForEnabled(page, SEL_FINAL_CART_BTN);
  await clickThenWait(page, SEL_FINAL_CART_BTN, {
    navWait: true,
    timeout: 90000,
  });

  // Mantener hold vivo ~10min
  // micro “tick” para no dormir la sesión (scroll ínfimo / no-op)
  await page.exposeFunction('noop', () => true).catch(() => {});
  await page
    .evaluate(() => {
      const id = setInterval(() => {
        try {
          window.scrollBy(0, 1);
          window.scrollBy(0, -1);
        } catch {}
      }, 25000);
      // @ts-ignore
      window.__keepAliveId = id;
    })
    .catch(() => {});
  console.log(`inst${idx}: HOLD de ${TICKETS_PER_PACK} tickets activo`);
  return { held: true };
}

//
// === Runner con puppeteer-cluster ===
//
(async () => {
  try {
    const cluster = await Cluster.launch({
      concurrency: Cluster.CONCURRENCY_CONTEXT,
      maxConcurrency: INSTANCES,
      puppeteer,
      puppeteerOptions: {
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--window-size=1366,820',
        ],
        defaultViewport: { width: 1366, height: 820 },
        slowMo: 30,
      },
      timeout: 5 * 60 * 1000, // antes del HOLD
    });

    await cluster.task(async ({ page, data: { idx } }) => {
      // Jitter leve para no pegarle todo a la vez
      await new Promise((resolve) => setTimeout(resolve, 1000));
      // await page
      //   .waitForTimeout(Math.floor(Math.random() * 300) + 100)
      //   .catch(() => {});
      let res;
      try {
        res = await runFlow(page, idx);
      } catch (e) {
        console.error(`inst${idx}: fallo en flujo`, e.message);
        return;
      }

      if (res?.held) {
        totalPacksHeld += 1;
        totalTicketsHeld += TICKETS_PER_PACK;
        saveProgress({
          instance: idx,
          held: true,
          packs: 1,
          tickets: TICKETS_PER_PACK,
        });

        // Mantener la pestaña abierta hasta que venza el hold
        // await page.waitForTimeout(HOLD_MS).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      } else {
        saveProgress({ instance: idx, held: false });
      }
    });

    // Encolar N instancias
    for (let i = 1; i <= INSTANCES; i++) {
      cluster.queue({ idx: i });
    }

    // Esperar a que terminen (tras el hold)
    await cluster.idle();
    await cluster.close();

    console.log('==== RESUMEN ====');
    console.log('Packs retenidos:', totalPacksHeld);
    console.log('Tickets retenidos:', totalTicketsHeld);
    console.log('Progreso en holds.json');
  } catch (error) {
    console.error('Error:', error);
  }
})();
