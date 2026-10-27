// Fills the clinic with demo slots for the next two weeks (weekdays, 9:00-16:00 Lagos time,
// 30 minutes each, three providers). Calls POST /reset, so it wipes existing bookings.
//
//   BASE_URL=https://your-app.vercel.app API_KEY=... npm run seed

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.API_KEY;
if (!KEY) {
  console.error('Set API_KEY');
  process.exit(1);
}

const PROVIDERS = ['Dr Ade Okafor', 'Dr Bisi Lawal', 'Nurse Chidi Eze'];
const LAGOS_OFFSET_HOURS = 1; // UTC+1, no daylight saving

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const slots = [];
const today = new Date();
for (let day = 1; day <= 14; day++) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day));
  const weekday = d.getUTCDay();
  if (weekday === 0 || weekday === 6) continue;
  PROVIDERS.forEach((provider, p) => {
    for (let half = 0; half < 14; half++) { // 9:00 to 16:00
      if ((half + p) % 5 === 4) continue; // leave some gaps so the grid looks real
      const start = new Date(d.getTime() + ((9 - LAGOS_OFFSET_HOURS) * 60 + half * 30) * 60_000);
      const end = new Date(start.getTime() + 30 * 60_000);
      const date = iso(d).slice(0, 10).replace(/-/g, '');
      slots.push({ id: `${date}-${p + 1}-${String(half).padStart(2, '0')}`, provider, start: iso(start), end: iso(end) });
    }
  });
}

fetch(`${BASE}/reset`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
  body: JSON.stringify({ slots }),
})
  .then(async (r) => {
    console.log(r.status, await r.text());
    if (!r.ok) process.exit(1);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
