import { createHash, randomBytes } from 'crypto';
import db from '../db.js';

export function hashResetToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

export function findValidResetToken(token) {
  if (!token) return null;
  const tokenHash = hashResetToken(token);
  return db.prepare(`
    SELECT pr.id, pr.user_id, u.email
    FROM password_resets pr
    JOIN users u ON u.id = pr.user_id
    WHERE pr.token_hash = ?
      AND pr.used_at IS NULL
      AND datetime(pr.expires_at) > datetime('now')
    ORDER BY pr.id DESC
    LIMIT 1
  `).get(tokenHash);
}

export function recordPasswordResetRequest(userId, ip) {
  const existing = db.prepare(`
    SELECT id
    FROM password_reset_requests
    WHERE user_id = ? AND status = 'pending'
    ORDER BY id DESC
    LIMIT 1
  `).get(userId);

  if (existing) {
    db.prepare(`
      UPDATE password_reset_requests
      SET requested_at = datetime('now'), request_ip = ?
      WHERE id = ?
    `).run(ip || null, existing.id);
    return existing.id;
  }

  return db.prepare(`
    INSERT INTO password_reset_requests (user_id, request_ip)
    VALUES (?, ?)
  `).run(userId, ip || null).lastInsertRowid;
}

export function listPasswordResetRequests(limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  return db.prepare(`
    SELECT
      rr.id,
      rr.user_id,
      rr.requested_at,
      rr.request_ip,
      rr.status,
      rr.handled_at,
      rr.handled_by,
      u.name,
      u.email,
      admin.name AS handled_by_name
    FROM password_reset_requests rr
    JOIN users u ON u.id = rr.user_id
    LEFT JOIN users admin ON admin.id = rr.handled_by
    ORDER BY CASE WHEN rr.status = 'pending' THEN 0 ELSE 1 END, rr.id DESC
    LIMIT ?
  `).all(safeLimit);
}

export function approvePasswordResetRequest(requestId, adminId) {
  const tx = db.transaction(() => {
    const request = db.prepare(`
      SELECT rr.id, rr.user_id, rr.status, u.name, u.email
      FROM password_reset_requests rr
      JOIN users u ON u.id = rr.user_id
      WHERE rr.id = ?
    `).get(requestId);

    if (!request || request.status !== 'pending') return null;

    const token = randomBytes(32).toString('hex');
    const tokenHash = hashResetToken(token);

    db.prepare(`
      UPDATE password_resets
      SET used_at = datetime('now')
      WHERE user_id = ? AND used_at IS NULL
    `).run(request.user_id);

    db.prepare(`
      INSERT INTO password_resets (user_id, token_hash, expires_at)
      VALUES (?, ?, datetime('now', '+30 minutes'))
    `).run(request.user_id, tokenHash);

    db.prepare(`
      UPDATE password_reset_requests
      SET status = 'approved', handled_at = datetime('now'), handled_by = ?
      WHERE id = ? AND status = 'pending'
    `).run(adminId, request.id);

    return { ...request, token };
  });

  return tx();
}

export function dismissPasswordResetRequest(requestId, adminId) {
  return db.prepare(`
    UPDATE password_reset_requests
    SET status = 'dismissed', handled_at = datetime('now'), handled_by = ?
    WHERE id = ? AND status = 'pending'
  `).run(adminId, requestId).changes > 0;
}
