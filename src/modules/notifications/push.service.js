import crypto from 'crypto';
import webpush from 'web-push';
import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';

let vapidConfigured = false;

function ensureVapidConfigured() {
  if (vapidConfigured) return true;
  if (!env.webPush.publicKey || !env.webPush.privateKey || !env.webPush.subject) return false;

  webpush.setVapidDetails(
    env.webPush.subject,
    env.webPush.publicKey,
    env.webPush.privateKey
  );
  vapidConfigured = true;
  return true;
}

function endpointHash(endpoint) {
  return crypto.createHash('sha256').update(String(endpoint)).digest('hex');
}

function normalizeSubscription(subscription) {
  const endpoint = String(subscription?.endpoint || '').trim();
  const p256dh = String(subscription?.keys?.p256dh || '').trim();
  const auth = String(subscription?.keys?.auth || '').trim();

  if (!endpoint || !p256dh || !auth) {
    const error = new Error('La suscripción push está incompleta.');
    error.code = 'INVALID_PUSH_SUBSCRIPTION';
    throw error;
  }

  return {
    endpoint,
    endpoint_hash: endpointHash(endpoint),
    p256dh,
    auth
  };
}

export function getPushPublicConfig() {
  return {
    enabled: ensureVapidConfigured(),
    publicKey: env.webPush.publicKey || null
  };
}

export async function savePushSubscription(userId, subscription, userAgent = null) {
  const normalized = normalizeSubscription(subscription);

  await pool.execute(`
    INSERT INTO push_subscriptions (
      user_id, endpoint_hash, endpoint, p256dh_key, auth_key, user_agent,
      active, last_error, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE
      user_id = VALUES(user_id),
      endpoint = VALUES(endpoint),
      p256dh_key = VALUES(p256dh_key),
      auth_key = VALUES(auth_key),
      user_agent = VALUES(user_agent),
      active = 1,
      last_error = NULL,
      updated_at_utc = UTC_TIMESTAMP()
  `, [
    userId,
    normalized.endpoint_hash,
    normalized.endpoint,
    normalized.p256dh,
    normalized.auth,
    userAgent ? String(userAgent).slice(0, 500) : null
  ]);

  return { endpoint: normalized.endpoint, active: true };
}

export async function removePushSubscription(userId, endpoint) {
  const hash = endpointHash(endpoint);
  await pool.execute(
    'UPDATE push_subscriptions SET active = 0, updated_at_utc = UTC_TIMESTAMP() WHERE user_id = ? AND endpoint_hash = ?',
    [userId, hash]
  );
}

function pushPayload(notification, badgeCount = 0) {
  const payload = notification?.payload && typeof notification.payload === 'object'
    ? notification.payload
    : {};

  return JSON.stringify({
    title: notification.title || 'Transdier',
    body: notification.message || 'Tienes una nueva notificación.',
    severity: notification.severity || 'INFO',
    created_at_utc: notification.created_at_utc || new Date().toISOString(),
    badgeCount: Number(badgeCount || 0),
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: notification.type === 'vehicle:restriction_requested'
      ? `restriction-request-${payload.restriction_request_id || notification.id}`
      : `transdier-notification-${notification.id}`,
    renotify: true,
    requireInteraction: notification.type === 'vehicle:restriction_requested',
    vibrate: [250, 120, 250, 120, 400],
    data: {
      url: '/notificaciones',
      notification_id: notification.id,
      type: notification.type,
      payload
    }
  });
}

function shouldSendPush(notification, force) {
  if (force) return true;
  return notification?.type === 'vehicle:restriction_requested'
    || notification?.severity === 'DANGER';
}

async function unreadCountFor(notification, recipientUserId) {
  if (notification.user_id) {
    const [rows] = await pool.execute(
      'SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND read_at_utc IS NULL',
      [recipientUserId]
    );
    return Number(rows[0]?.total || 0);
  }

  const [rows] = await pool.execute(`
    SELECT COUNT(*) AS total
    FROM restricted_vehicle_registration_requests
    WHERE status = 'PENDING'
  `);
  return Number(rows[0]?.total || 0);
}

async function subscriptionsFor(notification) {
  if (notification.user_id) {
    const [rows] = await pool.execute(`
      SELECT ps.*
      FROM push_subscriptions ps
      JOIN users u ON u.id = ps.user_id
      WHERE ps.user_id = ? AND ps.active = 1 AND u.active = 1
    `, [notification.user_id]);
    return rows;
  }

  const [rows] = await pool.execute(`
    SELECT ps.*
    FROM push_subscriptions ps
    JOIN users u ON u.id = ps.user_id
    WHERE ps.active = 1 AND u.active = 1 AND u.role = 'ADMIN'
  `);
  return rows;
}

async function recordSuccess(subscriptionId) {
  await pool.execute(`
    UPDATE push_subscriptions
    SET last_success_at_utc = UTC_TIMESTAMP(), last_error = NULL, updated_at_utc = UTC_TIMESTAMP()
    WHERE id = ?
  `, [subscriptionId]);
}

async function recordFailure(subscriptionId, error) {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  const expired = statusCode === 404 || statusCode === 410;
  const message = String(error?.body || error?.message || 'Error enviando notificación push').slice(0, 1000);

  await pool.execute(`
    UPDATE push_subscriptions
    SET active = ?, last_error = ?, updated_at_utc = UTC_TIMESTAMP()
    WHERE id = ?
  `, [expired ? 0 : 1, message, subscriptionId]);
}

export async function sendPushNotification(notification, { force = false } = {}) {
  if (!notification || !shouldSendPush(notification, force) || !ensureVapidConfigured()) {
    return { enabled: ensureVapidConfigured(), attempted: 0, sent: 0 };
  }

  let subscriptions;
  try {
    subscriptions = await subscriptionsFor(notification);
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      console.warn('Push omitido: falta ejecutar migration_notificaciones_push_pwa.sql.');
      return { enabled: true, attempted: 0, sent: 0, migrationRequired: true };
    }
    throw error;
  }

  let sent = 0;

  await Promise.all(subscriptions.map(async (row) => {
    const subscription = {
      endpoint: row.endpoint,
      keys: {
        p256dh: row.p256dh_key,
        auth: row.auth_key
      }
    };

    try {
      const badgeCount = await unreadCountFor(notification, row.user_id);
      const payload = pushPayload(notification, badgeCount);
      await webpush.sendNotification(subscription, payload, { TTL: 300, urgency: 'high' });
      sent += 1;
      await recordSuccess(row.id);
    } catch (error) {
      await recordFailure(row.id, error);
      console.error('No se pudo enviar una notificación push:', error?.statusCode || error?.message || error);
    }
  }));

  return { enabled: true, attempted: subscriptions.length, sent };
}
