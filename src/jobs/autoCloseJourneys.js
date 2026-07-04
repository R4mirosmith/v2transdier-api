import { pool, withTransaction } from '../db/pool.js';
import { createNotification, publishNotification } from '../modules/notifications/notification.service.js';

let running = false;

export async function closeDueJourneys() {
  if (running) return;
  running = true;
  try {
    const notifications = await withTransaction(async (conn) => {
      const [due] = await conn.execute(`
        SELECT j.*, f.name AS ferry_name
        FROM journeys j
        JOIN ferries f ON f.id = j.ferry_id
        WHERE j.status = 'OPEN' AND j.scheduled_close_at_utc IS NOT NULL AND j.scheduled_close_at_utc <= UTC_TIMESTAMP()
        FOR UPDATE
      `);
      const list = [];
      for (const journey of due) {
        await conn.execute(`
          UPDATE trips SET status = 'CLOSED', closed_at_utc = COALESCE(closed_at_utc, UTC_TIMESTAMP()), auto_closed = 1
          WHERE journey_id = ? AND status = 'OPEN'
        `, [journey.id]);
        await conn.execute(`
          UPDATE journeys SET status = 'CLOSED', closed_at_utc = UTC_TIMESTAMP(), auto_closed = 1
          WHERE id = ? AND status = 'OPEN'
        `, [journey.id]);
        const n = await createNotification(conn, {
          type: 'journey:auto_closed', severity: 'INFO', title: 'Jornada cerrada automáticamente',
          message: `La jornada de ${journey.ferry_name} fue cerrada automáticamente a las 11:59 p. m. Colombia.`,
          payload: { journey_id: journey.id }
        });
        list.push(n);
      }
      return list;
    });
    for (const n of notifications) publishNotification(n);
  } finally {
    running = false;
  }
}

export function startAutoCloseJourneysJob() {
  closeDueJourneys().catch((error) => console.error('Error auto cerrando jornadas:', error));
  setInterval(() => closeDueJourneys().catch((error) => console.error('Error auto cerrando jornadas:', error)), 60 * 1000);
}
