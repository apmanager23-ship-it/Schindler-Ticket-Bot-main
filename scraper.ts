import { chromium } from 'npm:playwright';

const ENABLE_GS = true;

const GOOGLE_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbyXgFuC6KE9V-qkoyxlr04YD4lIZHh1lduWhsEdkGMDwABMj4lcB1VSmJJzimqrx4Y_8A/exec';

const INDIVIDUAL_URL =
  'https://bilety.mhk.pl/rezerwacja/termin.html?idl=1&idg=0&idw=1&d=3';
const GROUP_URL =
  'https://bilety.mhk.pl/rezerwacja/termin.html?idl=1&idg=0&idw=2&d=3';

async function scrapeCategory(page: any, name: string, url: string) {
  await page.goto(url, { waitUntil: 'networkidle' });

  const monthsData: Array<{
    monthName: string;
    data: Record<string, { time: string; available: number }[]>;
  }> = [];

  const today = new Date();
  const todayDate = today.getDate();

  const MAX_MONTHS = 6;
  let consecutiveDaysWithoutTickets = 0;
  let foundNoTimeSlots = false;
  let monthIndex = 0;

  while (!foundNoTimeSlots && monthIndex < MAX_MONTHS) {
    let monthLoadSuccess = false;
    let monthLoadAttempt = 0;
    const maxMonthAttempts = 3;

    while (!monthLoadSuccess && monthLoadAttempt < maxMonthAttempts) {
      try {
        if (monthIndex > 0) {
          const nextMonthBtn = await page.$('a.month-switch.next-month');
          if (nextMonthBtn) {
            await page
              .waitForSelector('#loading', { state: 'hidden' })
              .catch(() => {});

            await nextMonthBtn.click({ timeout: 10000 });
            await page.waitForTimeout(1500);

            await page
              .waitForSelector('#loading', { state: 'hidden' })
              .catch(() => {});
            await page.waitForLoadState('networkidle');

            await page.waitForSelector('.kalendarz-terminow', {
              state: 'visible',
            });
            await page.waitForTimeout(500);
          } else {
            console.log(`⚠️ Brak przycisku następnego miesiąca dla ${name}`);
            break;
          }
        }

        const monthNameEl = await page.$('.cal-nazwa-miesiaca');
        const monthName = monthNameEl
          ? (await monthNameEl.innerText()).trim()
          : `Miesiąc ${monthIndex + 1}`;

        const monthData: Record<string, { time: string; available: number }[]> =
          {};

        const dayButtons = await page.$$('button.kalendarz-terminow-dzien');
        const availableDays: {
          btn: any;
          dayText: string;
          dayNumber: number;
        }[] = [];

        for (const btn of dayButtons) {
          const classes = (await btn.getAttribute('class')) || '';
          const style = (await btn.getAttribute('style')) || '';
          const tooltip =
            (await btn.getAttribute('data-bs-original-title')) || '';
          const dataDay = (await btn.getAttribute('data-day')) || '';

          const dayNumber = parseInt(dataDay.split('-')[2]) || 0;

          const dayText = (await btn.innerText()).trim();
          if (
            style.includes('#84edb7') &&
            tooltip.includes('Dzień bezpłatny')
          ) {
            monthData[dayText] = [
              { time: '🆓 Dzień bezpłatny', available: -1 },
            ];
            continue;
          }
          if (
            style.includes('#ffaa56') &&
            tooltip.includes('Dzień techniczny')
          ) {
            monthData[dayText] = [
              { time: '🔒 Muzeum nieczynne', available: -2 },
            ];
            continue;
          }

          if (
            (classes.includes('dzien-z-terminami') ||
              classes.includes('dzien-bez-terminow')) &&
            (monthIndex > 0 || dayNumber >= todayDate)
          ) {
            availableDays.push({ btn, dayText, dayNumber });
          }
        }

        let hasInvisibleButtons = false;

        for (let i = 0; i < availableDays.length; i++) {
          const { btn, dayText, dayNumber } = availableDays[i];

          const modal = await page.$('div.modal.fade.show');
          if (modal) {
            const closeBtn = await page.$('button.btn-close');
            if (closeBtn) {
              try {
                await closeBtn.click();
                await page.waitForTimeout(300);
              } catch (e) {
                await page.keyboard.press('Escape');
                await page.waitForTimeout(300);
              }
            }
          }

          await page.waitForLoadState('networkidle');

          try {
            await page
              .waitForSelector('#loading', { state: 'hidden' })
              .catch(() => {});

            const isVisible = await btn.isVisible();
            if (!isVisible) {
              console.log(
                `⚠️ Przycisk dnia ${dayText} niewidoczny, pomijam...`,
              );
              hasInvisibleButtons = true;
              continue;
            }

            await btn.click({ force: true, timeout: 10000 });
            await page.waitForTimeout(800);
          } catch (e) {
            console.log(
              `❌ Błąd podczas klikania na dzień ${dayText}, pomijam...`,
            );
            continue;
          }

          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(300);

          const slots: { time: string; available: number }[] = [];

          const cards = await page.$$('div.card.card-border-left');

          for (const card of cards) {
            const disabledLink = await card.$('a.btn-secondary.disabled');
            if (disabledLink) {
              const linkText = (await disabledLink.innerText()).trim();
              if (linkText.includes('Termin dostępny od')) {
                slots.push({
                  time: '⏳ Termin dostępny od',
                  available: -3,
                });
                continue;
              }
            }

            const cardTextEl = await card.$('p.card-text.text-muted');
            if (!cardTextEl) continue;

            const cardText = (await cardTextEl.innerText()).trim();
            const timeMatch = cardText.match(/(\d{2}:\d{2})$/);
            if (!timeMatch) continue;

            const time = timeMatch[1];

            const availableLink = await card.$('a.js-wybierz-termin-btn');

            if (availableLink) {
              const linkText = (await availableLink.innerText()).trim();
              const matchCount = linkText.match(/(\d+)\s*woln/i);
              const available = matchCount ? parseInt(matchCount[1]) : 1;
              slots.push({
                time: time,
                available: available,
              });
            } else if (disabledLink) {
              slots.push({
                time: time,
                available: 0,
              });
            }
          }

          if (slots.length > 0) {
            monthData[dayText] = slots;
          }
        }

        if (hasInvisibleButtons && monthIndex > 0) {
          monthLoadAttempt++;
          console.log(
            `⚠️ Miesiąc się nie załadował prawidłowo (attempt ${monthLoadAttempt}/${maxMonthAttempts}), retry...`,
          );
          continue;
        }

        if (Object.keys(monthData).length > 0) {
          const hasAnyAvailableTickets = Object.values(monthData).some(
            (daySlots) => daySlots.some((slot) => slot.available > 0),
          );
          if (hasAnyAvailableTickets) {
            monthsData.push({ monthName, data: monthData });
          } else {
            console.log(
              `ℹ️ ${name}: Pomijam miesiąc ${monthName} - brak dostępnych biletów`,
            );
          }
        }

        const noTimeSlotButtons = await page.$$(
          'button[data-bs-original-title="Brak terminów godzinowych w tym dniu"]',
        );
        if (noTimeSlotButtons.length > 0) {
          console.log(
            `ℹ️ ${name}: Znaleziono dni bez terminów godzinowych w miesiącu ${monthName}`,
          );
        }

        for (const { dayText } of availableDays) {
          const slots = monthData[dayText];
          if (!slots) continue;

          const allSlotsAreTerminDostepnyOd = slots.every(
            (slot) => slot.available === -3,
          );
          if (allSlotsAreTerminDostepnyOd) {
            consecutiveDaysWithoutTickets++;
            console.log(
              `⚠️ ${name}: Dzień z "Termin dostępny od" (${consecutiveDaysWithoutTickets}/3) - ${dayText} w ${monthName}`,
            );

            if (consecutiveDaysWithoutTickets >= 3) {
              console.log(
                `✅ ${name}: Znaleziono 3 dni pod rząd z "Termin dostępny od". Zatrzymuję sprawdzanie.`,
              );
              foundNoTimeSlots = true;
              break;
            }
          } else {
            consecutiveDaysWithoutTickets = 0;
          }
        }

        if (foundNoTimeSlots) {
          break;
        }

        monthLoadSuccess = true;
      } catch (e) {
        monthLoadAttempt++;
        console.error(
          `❌ Błąd podczas załadowania miesiąca (attempt ${monthLoadAttempt}/${maxMonthAttempts}):`,
          e,
        );
      }
    }

    if (!monthLoadSuccess) {
      console.log(
        `⚠️ Nie udało się załadować miesiąca po ${maxMonthAttempts} próbach, przerywam.`,
      );
      break;
    }

    monthIndex++;
  }

  return monthsData;
}

async function sendToGoogleSheets(ind: any, grp: any) {
  if (!ENABLE_GS) {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    const filename = `logs/${dateStr}_${timeStr}.txt`;

    await Deno.mkdir('logs', { recursive: true });

    let output = '\n🧪 TRYB TESTOWY - dane nie są wysyłane na Discord\n\n';
    output += '='.repeat(60) + '\n';
    output += '📊 BILETY INDYWIDUALNE:\n';
    output += '='.repeat(60) + '\n';
    for (const month of ind) {
      output += `\n📅 ${month.monthName}\n`;
      for (const [day, slots] of Object.entries(month.data)) {
        output += `  ${day}:\n`;
        for (const slot of slots as any[]) {
          if (slot.available === -1 || slot.available === -2) {
            output += `    ${slot.time}\n`;
          } else if (slot.available === -3) {
            output += `    ${slot.time}\n`;
          } else {
            const badge = slot.available > 0 ? '✅' : '❌';
            const count = slot.available > 0 ? ` (${slot.available})` : '';
            output += `    ${slot.time}${count}  ${badge}\n`;
          }
        }
      }
    }
    output += '\n' + '='.repeat(60) + '\n';
    output += '📊 BILETY GRUPOWE:\n';
    output += '='.repeat(60) + '\n';
    for (const month of grp) {
      output += `\n📅 ${month.monthName}\n`;
      for (const [day, slots] of Object.entries(month.data)) {
        output += `  ${day}:\n`;
        for (const slot of slots as any[]) {
          if (slot.available === -1 || slot.available === -2) {
            output += `    ${slot.time}\n`;
          } else if (slot.available === -3) {
            output += `    ${slot.time}\n`;
          } else {
            const badge = slot.available > 0 ? '✅' : '❌';
            output += `    ${slot.time}  ${badge}\n`;
          }
        }
      }
    }
    output += '\n' + '='.repeat(60) + '\n';

    await Deno.writeTextFile(filename, output);
    console.log(`✅ Dane zapisane do pliku: ${filename}`);
    return;
  }

  try {
    const payload = {
      individual: ind,
      group: grp,
    };

    const response = await fetch(GOOGLE_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    
    if (result.status === 'success') {
      console.log('✅ Dane wysłane do Google Sheets');
    } else {
      console.error('❌ Błąd:', result.message);
    }
  } catch (error) {
    console.error('❌ Błąd wysyłki do Google Sheets:', error);
    throw error;
  }

}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const indy = await scrapeCategory(page, 'Indywidualne', INDIVIDUAL_URL);
    const grp = await scrapeCategory(page, 'Grupowe', GROUP_URL);
    await sendToGoogleSheets(indy, grp);
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  main().catch((e) => console.error(e));
}
