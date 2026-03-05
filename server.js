const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const compression = require('compression');
const helmet = require('helmet');
const cookie = require('cookie');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 40 * 1024 * 1024,
  cors: { origin: false },
});

const PORT = Number(process.env.PORT || 3000);
const COOKIE_NAME = 'chat_session';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
const INACTIVE_DELETE_MS = 1000 * 60 * 60 * 24 * 90;
const MESSAGE_HISTORY_LIMIT = 200;
const MAX_ATTACHMENT_SIZE_BYTES = 12 * 1024 * 1024;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_ROOM_AVATAR_BYTES = 2 * 1024 * 1024;
const IS_PROD = process.env.NODE_ENV === 'production';

const dbPath = path.join(__dirname, 'data', 'chat_pro.sqlite');
const schemaPath = path.join(__dirname, 'db', 'schema.sql');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(schemaPath, 'utf8'));

function ensureColumn(tableName, columnName, alterSql) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!cols.some((c) => c.name === columnName)) {
    db.exec(alterSql);
  }
}

ensureColumn('messages', 'updated_at', 'ALTER TABLE messages ADD COLUMN updated_at INTEGER');
ensureColumn('rooms', 'updated_at', 'ALTER TABLE rooms ADD COLUMN updated_at INTEGER');
ensureColumn('rooms', 'visibility', "ALTER TABLE rooms ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'");
db.exec(`
  CREATE TABLE IF NOT EXISTS message_receipts (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    delivered_at INTEGER,
    seen_at INTEGER,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);
ensureColumn(
  'message_receipts',
  'delivered_at',
  'ALTER TABLE message_receipts ADD COLUMN delivered_at INTEGER'
);
ensureColumn('message_receipts', 'seen_at', 'ALTER TABLE message_receipts ADD COLUMN seen_at INTEGER');

const statements = {
  createUser: db.prepare(
    `INSERT INTO users (
      id, first_name, last_name, username, password_hash, avatar_base64, bio, theme, created_at, last_login_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  getUserByUsername: db.prepare(
    `SELECT
      id,
      first_name AS firstName,
      last_name AS lastName,
      username,
      password_hash AS passwordHash,
      avatar_base64 AS avatarBase64,
      bio,
      theme,
      last_login_at AS lastLoginAt
    FROM users
    WHERE username = ?`
  ),
  getUserById: db.prepare(
    `SELECT
      id,
      first_name AS firstName,
      last_name AS lastName,
      username,
      avatar_base64 AS avatarBase64,
      bio,
      theme,
      created_at AS createdAt,
      last_login_at AS lastLoginAt
    FROM users
    WHERE id = ?`
  ),
  updateUserProfile: db.prepare(
    `UPDATE users
     SET first_name = ?, last_name = ?, avatar_base64 = ?, bio = ?, theme = ?, last_seen_at = ?
     WHERE id = ?`
  ),
  touchUserSeen: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),
  touchUserLogin: db.prepare('UPDATE users SET last_login_at = ?, last_seen_at = ? WHERE id = ?'),
  searchUsers: db.prepare(
    `SELECT
      id,
      first_name AS firstName,
      last_name AS lastName,
      username,
      avatar_base64 AS avatarBase64,
      bio
    FROM users
    WHERE id != ?
      AND (
        username LIKE ? OR
        first_name LIKE ? OR
        last_name LIKE ? OR
        (first_name || ' ' || last_name) LIKE ?
      )
    ORDER BY first_name, last_name
    LIMIT 15`
  ),

  createSession: db.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  getSessionUserByTokenHash: db.prepare(
    `SELECT
      s.id AS sessionId,
      s.user_id AS userId,
      s.expires_at AS expiresAt,
      u.first_name AS firstName,
      u.last_name AS lastName,
      u.username,
      u.avatar_base64 AS avatarBase64,
      u.bio,
      u.theme
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`
  ),
  touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?'),
  deleteSessionByTokenHash: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

  createRoom: db.prepare(
    `INSERT OR IGNORE INTO rooms (id, name, bio, avatar_base64, is_group, visibility, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  getRoomById: db.prepare(
    `SELECT id, name, bio, avatar_base64 AS avatarBase64, is_group AS isGroup, visibility, created_by AS createdBy
     FROM rooms WHERE id = ?`
  ),
  searchGroups: db.prepare(
    `SELECT id, name, bio, avatar_base64 AS avatarBase64, is_group AS isGroup, visibility
     FROM rooms
     WHERE is_group = 1 AND (id LIKE ? OR name LIKE ?)
     ORDER BY name
     LIMIT 15`
  ),
  getPendingJoinRequest: db.prepare(
    'SELECT status FROM room_join_requests WHERE room_id = ? AND user_id = ?'
  ),
  upsertJoinRequest: db.prepare(`
    INSERT INTO room_join_requests (room_id, user_id, status, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, ?)
    ON CONFLICT(room_id, user_id)
    DO UPDATE SET status = 'pending', updated_at = excluded.updated_at
  `),
  setJoinRequestStatus: db.prepare(
    'UPDATE room_join_requests SET status = ?, updated_at = ? WHERE room_id = ? AND user_id = ?'
  ),
  pendingJoinRequestsForRoom: db.prepare(`
    SELECT
      rjr.room_id AS roomId,
      rjr.user_id AS userId,
      rjr.created_at AS createdAt,
      u.first_name || ' ' || u.last_name AS name,
      u.username,
      u.avatar_base64 AS avatarBase64
    FROM room_join_requests rjr
    JOIN users u ON u.id = rjr.user_id
    WHERE rjr.room_id = ? AND rjr.status = 'pending'
    ORDER BY rjr.created_at DESC
  `),
  moderatorPendingRequests: db.prepare(`
    SELECT
      rjr.room_id AS roomId,
      r.name AS roomName,
      rjr.user_id AS userId,
      rjr.created_at AS createdAt,
      u.first_name || ' ' || u.last_name AS name,
      u.username
    FROM room_join_requests rjr
    JOIN room_members rm ON rm.room_id = rjr.room_id
    JOIN rooms r ON r.id = rjr.room_id
    JOIN users u ON u.id = rjr.user_id
    WHERE rm.user_id = ?
      AND rm.role IN ('owner', 'admin')
      AND rjr.status = 'pending'
    ORDER BY rjr.created_at DESC
  `),
  getPendingInvitation: db.prepare(
    'SELECT status FROM room_invitations WHERE room_id = ? AND user_id = ?'
  ),
  upsertInvitation: db.prepare(`
    INSERT INTO room_invitations (room_id, user_id, invited_by, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(room_id, user_id)
    DO UPDATE SET invited_by = excluded.invited_by, status = 'pending', updated_at = excluded.updated_at
  `),
  setInvitationStatus: db.prepare(
    'UPDATE room_invitations SET status = ?, updated_at = ? WHERE room_id = ? AND user_id = ?'
  ),
  myPendingInvitations: db.prepare(`
    SELECT
      ri.room_id AS roomId,
      r.name AS roomName,
      ri.invited_by AS invitedBy,
      u.first_name || ' ' || u.last_name AS invitedByName,
      ri.created_at AS createdAt
    FROM room_invitations ri
    JOIN rooms r ON r.id = ri.room_id
    JOIN users u ON u.id = ri.invited_by
    WHERE ri.user_id = ? AND ri.status = 'pending'
    ORDER BY ri.created_at DESC
  `),

  insertRoomMember: db.prepare(
    `INSERT OR IGNORE INTO room_members (room_id, user_id, role, joined_at, last_active_at)
     VALUES (?, ?, ?, ?, ?)`
  ),
  touchRoomMember: db.prepare(
    `UPDATE room_members SET last_active_at = ? WHERE room_id = ? AND user_id = ?`
  ),
  getRoomMemberRole: db.prepare(
    `SELECT role FROM room_members WHERE room_id = ? AND user_id = ?`
  ),
  setRoomMemberRole: db.prepare(
    `UPDATE room_members SET role = ? WHERE room_id = ? AND user_id = ?`
  ),
  listRoomMembers: db.prepare(
    `SELECT
      rm.user_id AS id,
      rm.role,
      u.first_name || ' ' || u.last_name AS name,
      u.username,
      u.avatar_base64 AS avatarBase64,
      u.bio
     FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = ?
     ORDER BY CASE rm.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, u.first_name`
  ),
  getDirectPeerForRoom: db.prepare(
    `SELECT
      u.first_name || ' ' || u.last_name AS name,
      u.avatar_base64 AS avatarBase64,
      u.bio
     FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = ? AND rm.user_id != ?
     LIMIT 1`
  ),

  createMessage: db.prepare(
    'INSERT INTO messages (id, room_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
  getMessageById: db.prepare(
    'SELECT id, room_id AS roomId, user_id AS userId, text FROM messages WHERE id = ?'
  ),
  updateMessageText: db.prepare(
    'UPDATE messages SET text = ?, updated_at = ? WHERE id = ?'
  ),
  deleteMessageById: db.prepare('DELETE FROM messages WHERE id = ?'),
  createAttachment: db.prepare(
    'INSERT INTO attachments (id, message_id, name, mime_type, size_bytes, data_base64, format, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  upsertMessageReceipt: db.prepare(`
    INSERT INTO message_receipts (message_id, user_id, delivered_at, seen_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id, user_id)
    DO UPDATE SET
      delivered_at = CASE
        WHEN excluded.delivered_at IS NOT NULL THEN excluded.delivered_at
        ELSE message_receipts.delivered_at
      END,
      seen_at = CASE
        WHEN excluded.seen_at IS NOT NULL THEN excluded.seen_at
        ELSE message_receipts.seen_at
      END
  `),
  markReceiptsDeliveredForViewer: db.prepare(`
    UPDATE message_receipts
    SET delivered_at = COALESCE(delivered_at, ?)
    WHERE user_id = ?
      AND message_id IN (
        SELECT id FROM messages WHERE room_id = ? AND user_id != ?
      )
  `),
  markReceiptsSeenForViewer: db.prepare(`
    UPDATE message_receipts
    SET
      delivered_at = COALESCE(delivered_at, ?),
      seen_at = COALESCE(seen_at, ?)
    WHERE user_id = ?
      AND message_id IN (
        SELECT id FROM messages WHERE room_id = ? AND user_id != ?
      )
  `),
  receiptStatusesForRoomSenders: db.prepare(`
    SELECT
      m.id AS messageId,
      m.user_id AS senderId,
      COUNT(r.user_id) AS receiptCount,
      SUM(CASE WHEN r.delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS deliveredCount,
      SUM(CASE WHEN r.seen_at IS NOT NULL THEN 1 ELSE 0 END) AS seenCount
    FROM messages m
    LEFT JOIN message_receipts r ON r.message_id = m.id
    WHERE m.room_id = ?
    GROUP BY m.id, m.user_id
  `),
  getReactionByMessageAndUser: db.prepare(
    'SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?'
  ),
  upsertReaction: db.prepare(`
    INSERT INTO message_reactions (message_id, user_id, emoji, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id, user_id)
    DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at
  `),
  deleteReactionByMessageAndUser: db.prepare(
    'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?'
  ),
  reactionSummaryByRoom: db.prepare(`
    SELECT
      mr.message_id AS messageId,
      mr.emoji,
      COUNT(*) AS count,
      SUM(CASE WHEN mr.user_id = ? THEN 1 ELSE 0 END) AS reacted
    FROM message_reactions mr
    JOIN messages m ON m.id = mr.message_id
    WHERE m.room_id = ?
    GROUP BY mr.message_id, mr.emoji
  `),
  recentMessages: db.prepare(
    `SELECT
      m.id,
      m.room_id AS roomId,
      m.user_id AS userId,
      u.first_name || ' ' || u.last_name AS user,
      m.text,
      m.created_at AS at,
      a.name AS attachmentName,
      a.mime_type AS attachmentType,
      a.size_bytes AS attachmentSize,
      a.data_base64 AS attachmentData,
      a.format AS attachmentFormat,
      m.updated_at AS updatedAt
     FROM messages m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN attachments a ON a.message_id = m.id
     WHERE m.room_id = ?
     ORDER BY m.created_at DESC
     LIMIT ?`
  ),
  messageReceiptSummaryByRoom: db.prepare(`
    SELECT
      m.id AS messageId,
      COUNT(r.user_id) AS receiptCount,
      SUM(CASE WHEN r.delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS deliveredCount,
      SUM(CASE WHEN r.seen_at IS NOT NULL THEN 1 ELSE 0 END) AS seenCount
    FROM messages m
    LEFT JOIN message_receipts r ON r.message_id = m.id
    WHERE m.room_id = ?
    GROUP BY m.id
  `),
  updateRoomMeta: db.prepare(
    'UPDATE rooms SET name = ?, bio = ?, avatar_base64 = ?, visibility = ?, updated_at = ? WHERE id = ?'
  ),
  deleteRoomById: db.prepare('DELETE FROM rooms WHERE id = ?'),

  sidebarRooms: db.prepare(
    `SELECT
      r.id,
      r.name,
      r.bio,
      r.avatar_base64 AS avatarBase64,
      r.is_group AS isGroup,
      r.visibility,
      r.created_at AS createdAt,
      rm.role,
      COALESCE((SELECT MAX(m2.created_at) FROM messages m2 WHERE m2.room_id = r.id), r.created_at) AS lastActivity,
      (SELECT m3.text FROM messages m3 WHERE m3.room_id = r.id ORDER BY m3.created_at DESC LIMIT 1) AS lastMessage,
      (SELECT u.first_name || ' ' || u.last_name
       FROM messages m4
       JOIN users u ON u.id = m4.user_id
       WHERE m4.room_id = r.id
       ORDER BY m4.created_at DESC
       LIMIT 1) AS lastSender,
      (SELECT u2.id
       FROM room_members rm2
       JOIN users u2 ON u2.id = rm2.user_id
       WHERE rm2.room_id = r.id AND rm2.user_id != ?
       LIMIT 1) AS peerId,
      (SELECT u3.first_name || ' ' || u3.last_name
       FROM room_members rm3
       JOIN users u3 ON u3.id = rm3.user_id
       WHERE rm3.room_id = r.id AND rm3.user_id != ?
       LIMIT 1) AS peerName,
      (SELECT u4.username
       FROM room_members rm4
       JOIN users u4 ON u4.id = rm4.user_id
       WHERE rm4.room_id = r.id AND rm4.user_id != ?
       LIMIT 1) AS peerUsername,
      (SELECT u5.avatar_base64
       FROM room_members rm5
       JOIN users u5 ON u5.id = rm5.user_id
       WHERE rm5.room_id = r.id AND rm5.user_id != ?
       LIMIT 1) AS peerAvatarBase64
     FROM room_members rm
     JOIN rooms r ON r.id = rm.room_id
     WHERE rm.user_id = ?
       AND r.is_group = 0
     ORDER BY lastActivity DESC`
  ),

  deleteInactiveUsers: db.prepare('DELETE FROM users WHERE last_login_at <= ?'),
};

const roomPresence = new Map();
const onlineUsers = new Map();

function sanitizeText(value, maxLen = 1200) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

function safeRoomId(value) {
  const roomId = sanitizeText(value, 36).toLowerCase();
  return /^[a-z0-9_-]{3,36}$/.test(roomId) ? roomId : '';
}

function safeName(value) {
  const cleaned = sanitizeText(value, 40).replace(/\s+/g, ' ');
  return /^[a-zA-Z][a-zA-Z '\-]{0,39}$/.test(cleaned) ? cleaned : '';
}

function safeUsername(value) {
  const username = sanitizeText(value, 30).toLowerCase();
  return /^[a-z0-9_]{3,30}$/.test(username) ? username : '';
}

function safePassword(value) {
  const password = String(value || '');
  return password.length >= 8 && password.length <= 128 ? password : '';
}

function safeBio(value, maxLen = 220) {
  return sanitizeText(value, maxLen);
}

function safeTheme(value) {
  const theme = sanitizeText(value, 24).toLowerCase();
  if (['ocean', 'sunset', 'forest'].includes(theme)) return theme;
  return 'ocean';
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

function verifyPassword(password, stored) {
  const [salt, digest] = String(stored || '').split(':');
  if (!salt || !digest) return false;
  const computed = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(digest, 'hex');
  const b = Buffer.from(computed, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isValidBase64(data) {
  return typeof data === 'string' && /^[a-zA-Z0-9+/=\s]+$/.test(data);
}

function serializeSessionCookie(token) {
  return cookie.serialize(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
    path: '/',
  });
}

function clearSessionCookie() {
  return cookie.serialize(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 0,
    path: '/',
  });
}

function publicUser(user) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    avatarBase64: user.avatarBase64 || null,
    bio: user.bio || '',
    theme: user.theme || 'ocean',
    displayName: `${user.firstName} ${user.lastName}`,
  };
}

function createSession(userId) {
  const now = Date.now();
  const token = crypto.randomBytes(32).toString('hex');
  const sessionId = crypto.randomUUID();
  statements.createSession.run(sessionId, userId, hashToken(token), now, now + SESSION_MAX_AGE_MS, now);
  return token;
}

function cleanupInactiveUsers() {
  const now = Date.now();
  const cutoff = now - INACTIVE_DELETE_MS;
  statements.deleteExpiredSessions.run(now);
  return statements.deleteInactiveUsers.run(cutoff).changes;
}

function getAuthUserFromCookieHeader(cookieHeader = '') {
  const parsed = cookie.parse(cookieHeader || '');
  const token = parsed[COOKIE_NAME];
  if (!token || token.length < 20) return null;

  const tokenHash = hashToken(token);
  const sessionUser = statements.getSessionUserByTokenHash.get(tokenHash);
  if (!sessionUser) return null;
  if (sessionUser.expiresAt <= Date.now()) {
    statements.deleteSessionByTokenHash.run(tokenHash);
    return null;
  }

  statements.touchSession.run(Date.now(), sessionUser.sessionId);
  statements.touchUserSeen.run(Date.now(), sessionUser.userId);

  return {
    id: sessionUser.userId,
    firstName: sessionUser.firstName,
    lastName: sessionUser.lastName,
    username: sessionUser.username,
    avatarBase64: sessionUser.avatarBase64,
    bio: sessionUser.bio || '',
    theme: sessionUser.theme || 'ocean',
  };
}

function requireAuth(req, res, next) {
  const user = getAuthUserFromCookieHeader(req.headers.cookie || '');
  if (!user) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  req.user = user;
  next();
}

function getPresenceMembers(roomId) {
  const roomSockets = roomPresence.get(roomId);
  if (!roomSockets) return [];
  const unique = new Map();

  for (const member of roomSockets.values()) {
    unique.set(member.id, {
      id: member.id,
      name: member.name,
      role: member.role,
      avatarBase64: member.avatarBase64 || null,
    });
  }

  return [...unique.values()];
}

function emitToUserInRoom(roomId, userId, eventName, payload) {
  const roomSockets = roomPresence.get(roomId);
  if (!roomSockets) return;

  for (const [socketId, member] of roomSockets.entries()) {
    if (member.id === userId) {
      io.to(socketId).emit(eventName, payload);
    }
  }
}

function readMessages(roomId, viewerUserId) {
  const rows = statements.recentMessages.all(roomId, MESSAGE_HISTORY_LIMIT).reverse();
  const reactionRows = statements.reactionSummaryByRoom.all(viewerUserId, roomId);
  const receiptRows = statements.messageReceiptSummaryByRoom.all(roomId);
  const reactionsByMessage = new Map();
  const receiptByMessage = new Map();

  for (const row of reactionRows) {
    if (!reactionsByMessage.has(row.messageId)) reactionsByMessage.set(row.messageId, []);
    reactionsByMessage.get(row.messageId).push({
      emoji: row.emoji,
      count: Number(row.count),
      reacted: Number(row.reacted) > 0,
    });
  }

  for (const row of receiptRows) {
    receiptByMessage.set(row.messageId, {
      receiptCount: Number(row.receiptCount || 0),
      deliveredCount: Number(row.deliveredCount || 0),
      seenCount: Number(row.seenCount || 0),
    });
  }

  return rows.map((row) => ({
    ...(function statusPayload() {
      const summary = receiptByMessage.get(row.id) || {
        receiptCount: 0,
        deliveredCount: 0,
        seenCount: 0,
      };
      let status = null;
      if (row.userId === viewerUserId) {
        if (summary.receiptCount > 0 && summary.seenCount === summary.receiptCount) status = 'seen';
        else if (summary.receiptCount > 0 && summary.deliveredCount === summary.receiptCount)
          status = 'received';
        else status = 'sent';
      }
      return { status };
    })(),
    id: row.id,
    roomId: row.roomId,
    userId: row.userId,
    user: row.user,
    text: row.text || '',
    at: row.at,
    attachment: row.attachmentData
      ? {
          name: row.attachmentName,
          type: row.attachmentType,
          sizeBytes: row.attachmentSize,
          data: row.attachmentData,
          format: row.attachmentFormat,
        }
      : null,
    encoding: row.attachmentData ? row.attachmentFormat : null,
    editedAt: row.updatedAt || null,
    reactions: reactionsByMessage.get(row.id) || [],
  }));
}

function toMessageStatusFromReceiptRow(row) {
  const receiptCount = Number(row.receiptCount || 0);
  const deliveredCount = Number(row.deliveredCount || 0);
  const seenCount = Number(row.seenCount || 0);
  if (receiptCount > 0 && seenCount === receiptCount) return 'seen';
  if (receiptCount > 0 && deliveredCount === receiptCount) return 'received';
  return 'sent';
}

function isSupportedAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return false;

  const type = String(attachment.type || '');
  const bytes = Number(attachment.sizeBytes || 0);
  const data = String(attachment.data || '');
  const format = String(attachment.format || 'base64').toLowerCase();

  const allowedType =
    type.startsWith('image/') ||
    type.startsWith('audio/') ||
    type.startsWith('video/') ||
    type === 'application/pdf' ||
    type === 'application/msword' ||
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  return (
    allowedType &&
    format === 'base64' &&
    isValidBase64(data) &&
    bytes > 0 &&
    bytes <= MAX_ATTACHMENT_SIZE_BYTES &&
    data.length > 0
  );
}

function ensureRoomMember(roomId, userId, role = 'member') {
  const now = Date.now();
  statements.insertRoomMember.run(roomId, userId, role, now, now);
  statements.touchRoomMember.run(now, roomId, userId);
}

function makeDirectRoomId(userA, userB) {
  const [a, b] = [userA, userB].sort();
  return `dm_${a.slice(0, 8)}_${b.slice(0, 8)}_${hashToken(`${a}:${b}`).slice(0, 8)}`;
}

function getSidebar(userId) {
  const rows = statements.sidebarRooms.all(userId, userId, userId, userId, userId);
  const chats = [];

  for (const row of rows) {
    chats.push({
      id: row.id,
      name: row.peerName || 'Direct Chat',
      username: row.peerUsername || null,
      avatarBase64: row.peerAvatarBase64 || null,
      bio: row.bio || '',
      role: row.role,
      isGroup: false,
      visibility: row.visibility || 'public',
      lastActivity: row.lastActivity,
      lastMessage: row.lastMessage || '',
      lastSender: row.lastSender || '',
      peerId: row.peerId || null,
    });
  }

  return { chats };
}

function listMembersWithPresence(roomId) {
  const dbMembers = statements.listRoomMembers.all(roomId);
  const onlineIds = new Set(getPresenceMembers(roomId).map((m) => m.id));
  return dbMembers.map((member) => ({
    ...member,
    online: onlineIds.has(member.id),
  }));
}

function canModerateMessages(role) {
  return role === 'owner' || role === 'admin';
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '30mb' }));

cleanupInactiveUsers();
setInterval(cleanupInactiveUsers, 1000 * 60 * 60 * 6);

app.get('/health', (_, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

app.post('/api/auth/register', (req, res) => {
  const rawFirstName = String(req.body.firstName || '');
  const rawLastName = String(req.body.lastName || '');
  const rawUsername = String(req.body.username || '');
  const rawPassword = String(req.body.password || '');

  const firstName = safeName(rawFirstName);
  const lastName = safeName(rawLastName);
  const username = safeUsername(rawUsername);
  const password = safePassword(rawPassword);
  const avatarBase64 = req.body.avatarBase64 ? String(req.body.avatarBase64) : null;

  if (!firstName) {
    res.status(400).json({
      ok: false,
      error: 'First name invalid. Use letters only (A-Z), max 40 chars.',
    });
    return;
  }

  if (!lastName) {
    res.status(400).json({
      ok: false,
      error: 'Last name invalid. Use letters only (A-Z), max 40 chars.',
    });
    return;
  }

  if (!username) {
    res.status(400).json({
      ok: false,
      error: 'Username invalid. Use lowercase letters, numbers, underscore (3-30).',
    });
    return;
  }

  if (!password) {
    res.status(400).json({
      ok: false,
      error: 'Password must be 8 to 128 characters.',
    });
    return;
  }

  if (avatarBase64) {
    if (!isValidBase64(avatarBase64)) {
      res.status(400).json({ ok: false, error: 'Invalid avatar encoding.' });
      return;
    }
    const bytes = Buffer.from(avatarBase64, 'base64').length;
    if (bytes > MAX_AVATAR_BYTES) {
      res.status(400).json({ ok: false, error: 'Avatar too large (max 2MB).' });
      return;
    }
  }

  const exists = statements.getUserByUsername.get(username);
  if (exists) {
    res.status(409).json({ ok: false, error: 'Username already exists.' });
    return;
  }

  const now = Date.now();
  const userId = crypto.randomUUID();

  statements.createUser.run(
    userId,
    firstName,
    lastName,
    username,
    hashPassword(password),
    avatarBase64,
    '',
    'ocean',
    now,
    now,
    now
  );

  const token = createSession(userId);
  res.setHeader('Set-Cookie', serializeSessionCookie(token));

  const user = statements.getUserById.get(userId);
  res.status(201).json({ ok: true, user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const username = safeUsername(req.body.username);
  const password = safePassword(req.body.password);

  if (!username || !password) {
    res.status(400).json({ ok: false, error: 'Invalid username or password.' });
    return;
  }

  const user = statements.getUserByUsername.get(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ ok: false, error: 'Incorrect username or password.' });
    return;
  }

  const now = Date.now();
  statements.touchUserLogin.run(now, now, user.id);

  const token = createSession(user.id);
  res.setHeader('Set-Cookie', serializeSessionCookie(token));

  const updated = statements.getUserById.get(user.id);
  res.json({ ok: true, user: publicUser(updated) });
});

app.post('/api/auth/logout', (req, res) => {
  const parsed = cookie.parse(req.headers.cookie || '');
  const token = parsed[COOKIE_NAME];
  if (token) statements.deleteSessionByTokenHash.run(hashToken(token));

  res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = statements.getUserById.get(req.user.id);
  res.json({ ok: true, user: publicUser(user) });
});

app.put('/api/auth/profile', requireAuth, (req, res) => {
  const firstName = safeName(req.body.firstName);
  const lastName = safeName(req.body.lastName);
  const avatarBase64 = req.body.avatarBase64 ? String(req.body.avatarBase64) : null;
  const bio = safeBio(req.body.bio || '', 220);
  const theme = safeTheme(req.body.theme || 'ocean');

  if (!firstName || !lastName) {
    res.status(400).json({ ok: false, error: 'Invalid profile input.' });
    return;
  }

  if (avatarBase64) {
    if (!isValidBase64(avatarBase64)) {
      res.status(400).json({ ok: false, error: 'Invalid avatar encoding.' });
      return;
    }
    const bytes = Buffer.from(avatarBase64, 'base64').length;
    if (bytes > MAX_AVATAR_BYTES) {
      res.status(400).json({ ok: false, error: 'Avatar too large (max 2MB).' });
      return;
    }
  }

  statements.updateUserProfile.run(firstName, lastName, avatarBase64, bio, theme, Date.now(), req.user.id);
  const updated = statements.getUserById.get(req.user.id);
  res.json({ ok: true, user: publicUser(updated) });
});

app.get('/api/sidebar', requireAuth, (req, res) => {
  res.json({ ok: true, ...getSidebar(req.user.id) });
});

app.get('/api/discovery', requireAuth, (req, res) => {
  const q = sanitizeText(req.query.q || '', 40);
  if (!q) {
    res.json({ ok: true, people: [], groups: [] });
    return;
  }

  const term = `%${q}%`;
  const people = statements.searchUsers.all(req.user.id, term, term, term, term).map((u) => ({
    id: u.id,
    name: `${u.firstName} ${u.lastName}`,
    username: u.username,
    avatarBase64: u.avatarBase64 || null,
    bio: u.bio || '',
  }));

  res.json({ ok: true, people, groups: [] });
});

app.get('/api/users/:id', requireAuth, (req, res) => {
  const user = statements.getUserById.get(req.params.id);
  if (!user) {
    res.status(404).json({ ok: false, error: 'User not found.' });
    return;
  }

  res.json({
    ok: true,
    profile: {
      id: user.id,
      name: `${user.firstName} ${user.lastName}`,
      username: user.username,
      avatarBase64: user.avatarBase64 || null,
      bio: user.bio || '',
      theme: user.theme || 'ocean',
    },
  });
});

app.get('/api/group/pending', requireAuth, (req, res) => {
  res.status(410).json({ ok: false, error: 'Groups are disabled. 1-to-1 chat only.' });
});

app.post('/api/group/invite/respond', requireAuth, (req, res) => {
  res.status(410).json({ ok: false, error: 'Groups are disabled. 1-to-1 chat only.' });
});

app.post('/api/group/request/respond', requireAuth, (req, res) => {
  res.status(410).json({ ok: false, error: 'Groups are disabled. 1-to-1 chat only.' });
});

app.use(express.static(path.join(__dirname, 'public')));

io.use((socket, next) => {
  const user = getAuthUserFromCookieHeader(socket.handshake.headers.cookie || '');
  if (!user) {
    next(new Error('Not logged in. Please login first.'));
    return;
  }
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  let currentRoomId = '';
  let recentMessageTimestamps = [];
  onlineUsers.set(socket.data.user.id, (onlineUsers.get(socket.data.user.id) || 0) + 1);

  socket.on('createOrJoinRoom', (payload = {}, ack) => {
    const roomId = safeRoomId(payload.roomId);

    if (!roomId) {
      ack?.({ ok: false, error: 'Invalid room ID.' });
      return;
    }

    const now = Date.now();
    const displayName = `${socket.data.user.firstName} ${socket.data.user.lastName}`;
    const existing = statements.getRoomById.get(roomId);

    if (!existing || existing.isGroup) {
      ack?.({ ok: false, error: 'Direct chat not found.' });
      return;
    }

    const myRole = statements.getRoomMemberRole.get(roomId, socket.data.user.id)?.role;
    if (!myRole) {
      ack?.({ ok: false, error: 'You are not part of this direct chat.' });
      return;
    }

    statements.touchRoomMember.run(now, roomId, socket.data.user.id);

    if (currentRoomId && roomPresence.has(currentRoomId)) {
      const oldPresence = roomPresence.get(currentRoomId);
      oldPresence.delete(socket.id);
      if (oldPresence.size === 0) roomPresence.delete(currentRoomId);
      socket.leave(currentRoomId);
      io.to(currentRoomId).emit('membersUpdated', listMembersWithPresence(currentRoomId));
    }

    currentRoomId = roomId;
    socket.join(roomId);

    if (!roomPresence.has(roomId)) roomPresence.set(roomId, new Map());
    roomPresence.get(roomId).set(socket.id, {
      id: socket.data.user.id,
      name: displayName,
      role: 'member',
      avatarBase64: socket.data.user.avatarBase64 || null,
    });

    const room = statements.getRoomById.get(roomId);
    const peer = statements.getDirectPeerForRoom.get(roomId, socket.data.user.id);
    const members = listMembersWithPresence(roomId);

    const receiptTx = db.transaction(() => {
      statements.markReceiptsDeliveredForViewer.run(now, socket.data.user.id, roomId, socket.data.user.id);
      statements.markReceiptsSeenForViewer.run(now, now, socket.data.user.id, roomId, socket.data.user.id);
    });
    receiptTx();

    const receiptStatuses = statements.receiptStatusesForRoomSenders.all(roomId);
    for (const row of receiptStatuses) {
      if (row.senderId === socket.data.user.id) continue;
      emitToUserInRoom(roomId, row.senderId, 'message:status', {
        messageId: row.messageId,
        status: toMessageStatusFromReceiptRow(row),
      });
    }

    const messages = readMessages(roomId, socket.data.user.id);

    ack?.({
      ok: true,
      room: {
        id: room.id,
        name: peer?.name || 'Direct Chat',
        bio: peer?.bio || '',
        avatarBase64: peer?.avatarBase64 || null,
        isGroup: false,
        visibility: 'public',
      },
      members,
      messages,
      role: 'member',
    });

    socket.to(roomId).emit('memberJoined', {
      id: socket.data.user.id,
      name: displayName,
      at: now,
    });

    io.to(roomId).emit('membersUpdated', listMembersWithPresence(roomId));
  });

  socket.on('openDirectChat', (payload = {}, ack) => {
    const targetUserId = sanitizeText(payload.targetUserId, 64);
    if (!targetUserId || targetUserId === socket.data.user.id) {
      ack?.({ ok: false, error: 'Invalid user.' });
      return;
    }

    const targetUser = statements.getUserById.get(targetUserId);
    if (!targetUser) {
      ack?.({ ok: false, error: 'User not found.' });
      return;
    }

    const roomId = makeDirectRoomId(socket.data.user.id, targetUserId);
    const now = Date.now();

    statements.createRoom.run(roomId, null, '', null, 0, 'public', socket.data.user.id, now);
    ensureRoomMember(roomId, socket.data.user.id, 'member');
    ensureRoomMember(roomId, targetUserId, 'member');

    ack?.({ ok: true, roomId });
  });

  socket.on('group:setRole', (payload = {}, ack) => {
    ack?.({ ok: false, error: 'Groups are disabled. 1-to-1 chat only.' });
  });

  socket.on('group:invite', (payload = {}, ack) => {
    ack?.({ ok: false, error: 'Groups are disabled. 1-to-1 chat only.' });
  });

  socket.on('room:getState', (payload = {}, ack) => {
    const roomId = safeRoomId(payload.roomId);
    if (!roomId) {
      ack?.({ ok: false, error: 'Invalid room.' });
      return;
    }

    const roleRow = statements.getRoomMemberRole.get(roomId, socket.data.user.id);
    if (!roleRow) {
      ack?.({ ok: false, error: 'Not a member of this room.' });
      return;
    }

    const room = statements.getRoomById.get(roomId);
    if (!room) {
      ack?.({ ok: false, error: 'Room not found.' });
      return;
    }
    const peer = statements.getDirectPeerForRoom.get(roomId, socket.data.user.id);

    ack?.({
      ok: true,
      room: {
        id: room.id,
        name: peer?.name || 'Direct Chat',
        bio: peer?.bio || '',
        avatarBase64: peer?.avatarBase64 || null,
        isGroup: false,
        visibility: 'public',
      },
      members: listMembersWithPresence(roomId),
      messages: readMessages(roomId, socket.data.user.id),
      role: 'member',
    });
  });

  socket.on('group:update', (payload = {}, ack) => {
    ack?.({ ok: false, error: 'Groups are disabled. 1-to-1 chat only.' });
  });

  socket.on('group:delete', (payload = {}, ack) => {
    ack?.({ ok: false, error: 'Groups are disabled. 1-to-1 chat only.' });
  });

  socket.on('chatMessage', (payload = {}, ack) => {
    if (!currentRoomId) {
      ack?.({ ok: false, error: 'Join a room first.' });
      return;
    }

    const membership = statements.getRoomMemberRole.get(currentRoomId, socket.data.user.id);
    if (!membership) {
      ack?.({ ok: false, error: 'You are not a member of this room.' });
      return;
    }

    const now = Date.now();
    recentMessageTimestamps = recentMessageTimestamps.filter((ts) => now - ts < 5000);
    if (recentMessageTimestamps.length >= 20) {
      ack?.({ ok: false, error: 'Rate limit exceeded. Slow down.' });
      return;
    }
    recentMessageTimestamps.push(now);

    const text = sanitizeText(payload.text, 2000);
    const attachment = payload.attachment || null;

    if (!text && !attachment) {
      ack?.({ ok: false, error: 'Empty message.' });
      return;
    }

    if (attachment && !isSupportedAttachment(attachment)) {
      ack?.({ ok: false, error: 'Unsupported or oversized file (max 12MB).' });
      return;
    }

    const messageId = crypto.randomUUID();
    const roomMembers = statements.listRoomMembers.all(currentRoomId);
    const onlineInRoom = new Set(getPresenceMembers(currentRoomId).map((m) => m.id));
    const isOnlineAnywhere = (userId) => (onlineUsers.get(userId) || 0) > 0;
    let senderStatus = 'sent';

    const tx = db.transaction(() => {
      statements.createMessage.run(messageId, currentRoomId, socket.data.user.id, text || null, now);

      if (attachment) {
        statements.createAttachment.run(
          crypto.randomUUID(),
          messageId,
          sanitizeText(attachment.name, 120) || 'file',
          attachment.type,
          Number(attachment.sizeBytes),
          attachment.data,
          'base64',
          now
        );
      }

      statements.touchUserSeen.run(now, socket.data.user.id);
      statements.touchRoomMember.run(now, currentRoomId, socket.data.user.id);

      for (const member of roomMembers) {
        if (member.id === socket.data.user.id) continue;
        const deliveredAt = isOnlineAnywhere(member.id) ? now : null;
        const seenAt = onlineInRoom.has(member.id) ? now : null;
        statements.upsertMessageReceipt.run(messageId, member.id, deliveredAt, seenAt);
      }
    });

    tx();

    const recipient = roomMembers.find((m) => m.id !== socket.data.user.id);
    if (recipient) {
      if (onlineInRoom.has(recipient.id)) senderStatus = 'seen';
      else if (isOnlineAnywhere(recipient.id)) senderStatus = 'received';
      else senderStatus = 'sent';
    }

    const message = {
      id: messageId,
      roomId: currentRoomId,
      userId: socket.data.user.id,
      user: `${socket.data.user.firstName} ${socket.data.user.lastName}`,
      text,
      attachment: attachment
        ? {
            name: sanitizeText(attachment.name, 120) || 'file',
            type: attachment.type,
            sizeBytes: Number(attachment.sizeBytes),
            data: attachment.data,
            format: 'base64',
          }
        : null,
      encoding: attachment ? 'base64' : null,
      reactions: [],
      status: senderStatus,
      at: now,
    };

    io.to(currentRoomId).emit('chatMessage', message);
    ack?.({ ok: true });
  });

  socket.on('message:edit', (payload = {}, ack) => {
    const messageId = sanitizeText(payload.messageId, 80);
    const text = sanitizeText(payload.text, 2000);

    if (!currentRoomId) {
      ack?.({ ok: false, error: 'Join a room first.' });
      return;
    }
    if (!messageId || !text) {
      ack?.({ ok: false, error: 'Invalid edit payload.' });
      return;
    }

    const msg = statements.getMessageById.get(messageId);
    if (!msg || msg.roomId !== currentRoomId) {
      ack?.({ ok: false, error: 'Message not found.' });
      return;
    }

    const role = statements.getRoomMemberRole.get(currentRoomId, socket.data.user.id)?.role;
    const canEdit = msg.userId === socket.data.user.id || canModerateMessages(role);
    if (!canEdit) {
      ack?.({ ok: false, error: 'Permission denied.' });
      return;
    }

    const now = Date.now();
    statements.updateMessageText.run(text, now, messageId);
    io.to(currentRoomId).emit('message:edited', {
      messageId,
      text,
      editedAt: now,
    });
    ack?.({ ok: true });
  });

  socket.on('message:delete', (payload = {}, ack) => {
    const messageId = sanitizeText(payload.messageId, 80);
    if (!currentRoomId) {
      ack?.({ ok: false, error: 'Join a room first.' });
      return;
    }
    if (!messageId) {
      ack?.({ ok: false, error: 'Invalid delete payload.' });
      return;
    }

    const msg = statements.getMessageById.get(messageId);
    if (!msg || msg.roomId !== currentRoomId) {
      ack?.({ ok: false, error: 'Message not found.' });
      return;
    }

    const role = statements.getRoomMemberRole.get(currentRoomId, socket.data.user.id)?.role;
    const canDelete = msg.userId === socket.data.user.id || canModerateMessages(role);
    if (!canDelete) {
      ack?.({ ok: false, error: 'Permission denied.' });
      return;
    }

    statements.deleteMessageById.run(messageId);
    io.to(currentRoomId).emit('message:deleted', { messageId });
    ack?.({ ok: true });
  });

  socket.on('message:react', (payload = {}, ack) => {
    const messageId = sanitizeText(payload.messageId, 80);
    const emoji = sanitizeText(payload.emoji, 8);
    if (!currentRoomId) {
      ack?.({ ok: false, error: 'Join a room first.' });
      return;
    }
    if (!messageId || !emoji) {
      ack?.({ ok: false, error: 'Invalid reaction payload.' });
      return;
    }

    const msg = statements.getMessageById.get(messageId);
    if (!msg || msg.roomId !== currentRoomId) {
      ack?.({ ok: false, error: 'Message not found.' });
      return;
    }

    const existing = statements.getReactionByMessageAndUser.get(messageId, socket.data.user.id);
    if (existing && existing.emoji === emoji) {
      statements.deleteReactionByMessageAndUser.run(messageId, socket.data.user.id);
    } else {
      statements.upsertReaction.run(messageId, socket.data.user.id, emoji, Date.now());
    }

    const rows = statements.reactionSummaryByRoom.all(socket.data.user.id, currentRoomId);
    const reactions = rows
      .filter((r) => r.messageId === messageId)
      .map((r) => ({ emoji: r.emoji, count: Number(r.count), reacted: Number(r.reacted) > 0 }));

    io.to(currentRoomId).emit('message:reactions', { messageId, reactions });
    ack?.({ ok: true, reactions });
  });

  socket.on('call:offer', (payload = {}, ack) => {
    if (!currentRoomId) {
      ack?.({ ok: false, error: 'Join a room first.' });
      return;
    }

    const toUserId = sanitizeText(payload.toUserId, 128);
    const mode = payload.mode === 'video' ? 'video' : 'voice';
    if (!toUserId || !payload.sdp) {
      ack?.({ ok: false, error: 'Invalid offer payload.' });
      return;
    }

    emitToUserInRoom(currentRoomId, toUserId, 'call:offer', {
      fromUserId: socket.data.user.id,
      fromName: `${socket.data.user.firstName} ${socket.data.user.lastName}`,
      mode,
      sdp: payload.sdp,
    });
    ack?.({ ok: true });
  });

  socket.on('call:answer', (payload = {}, ack) => {
    if (!currentRoomId) {
      ack?.({ ok: false, error: 'Join a room first.' });
      return;
    }

    const toUserId = sanitizeText(payload.toUserId, 128);
    if (!toUserId || !payload.sdp) {
      ack?.({ ok: false, error: 'Invalid answer payload.' });
      return;
    }

    emitToUserInRoom(currentRoomId, toUserId, 'call:answer', {
      fromUserId: socket.data.user.id,
      fromName: `${socket.data.user.firstName} ${socket.data.user.lastName}`,
      sdp: payload.sdp,
    });
    ack?.({ ok: true });
  });

  socket.on('call:ice', (payload = {}, ack) => {
    if (!currentRoomId) {
      ack?.({ ok: false, error: 'Join a room first.' });
      return;
    }

    const toUserId = sanitizeText(payload.toUserId, 128);
    if (!toUserId || !payload.candidate) {
      ack?.({ ok: false, error: 'Invalid ICE payload.' });
      return;
    }

    emitToUserInRoom(currentRoomId, toUserId, 'call:ice', {
      fromUserId: socket.data.user.id,
      fromName: `${socket.data.user.firstName} ${socket.data.user.lastName}`,
      candidate: payload.candidate,
    });
    ack?.({ ok: true });
  });

  socket.on('call:end', () => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('call:end', {
      fromUserId: socket.data.user.id,
      fromName: `${socket.data.user.firstName} ${socket.data.user.lastName}`,
    });
  });

  socket.on('disconnect', () => {
    const remaining = (onlineUsers.get(socket.data.user.id) || 1) - 1;
    if (remaining <= 0) onlineUsers.delete(socket.data.user.id);
    else onlineUsers.set(socket.data.user.id, remaining);

    if (!currentRoomId || !roomPresence.has(currentRoomId)) return;

    const roomSockets = roomPresence.get(currentRoomId);
    const member = roomSockets.get(socket.id);
    roomSockets.delete(socket.id);

    if (roomSockets.size === 0) roomPresence.delete(currentRoomId);

    io.to(currentRoomId).emit('membersUpdated', listMembersWithPresence(currentRoomId));

    if (member) {
      socket.to(currentRoomId).emit('memberLeft', {
        id: member.id,
        name: member.name,
        at: Date.now(),
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Live chat running at http://localhost:${PORT}`);
});
