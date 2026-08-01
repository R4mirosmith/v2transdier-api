import { pool } from '../../db/pool.js';
import { emitToAdmins, emitToUser } from '../../sockets/index.js';
import { sendPushNotification } from './push.service.js';

export async function createNotification(connOrPool, data) {
  const executor = connOrPool || pool;
  const payloadJson = data.payload ? JSON.stringify(data.payload) : null;
  const [result] = await executor.execute(
    `INSERT INTO notifications (type, severity, title, message, payload_json, user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [data.type, data.severity || 'INFO', data.title, data.message, payloadJson, data.user_id || null]
  );
  const notification = { id: result.insertId, ...data, created_at_utc: new Date().toISOString() };
  return notification;
}

export function publishNotification(notification) {
  if (!notification) return;
  if (notification.user_id) emitToUser(notification.user_id, 'notification:new', notification);
  else emitToAdmins('notification:new', notification);

  // El socket avisa cuando la plataforma está abierta. Web Push cubre segundo plano o app cerrada.
  void sendPushNotification(notification).catch((error) => {
    console.error('Error publicando notificación push:', error);
  });
}
