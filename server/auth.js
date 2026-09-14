'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const AUTH_USERNAME = process.env.AUTH_USERNAME || 'admin';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'change-me-please';
const JWT_SECRET = process.env.JWT_SECRET || 'insecure-dev-secret-change-me';
const SESSION_TTL_SECONDS = parseInt(process.env.SESSION_TTL_SECONDS || '43200', 10);
const SECURE_COOKIE = String(process.env.SECURE_COOKIE || 'false').toLowerCase() === 'true';
const COOKIE_NAME = 'relay_session';

if (JWT_SECRET === 'insecure-dev-secret-change-me') {
  console.warn('[auth] WARNING: JWT_SECRET is not set. Using an insecure default. Set JWT_SECRET in production.');
}

/**
 * Constant-time comparison to avoid timing leaks on the static credentials.
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Still do a comparison to keep timing roughly constant.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function verifyCredentials(username, password) {
  const userOk = safeEqual(username || '', AUTH_USERNAME);
  const passOk = safeEqual(password || '', AUTH_PASSWORD);
  return userOk && passOk;
}

function issueToken(username) {
  return jwt.sign({ sub: username }, JWT_SECRET, { expiresIn: SESSION_TTL_SECONDS });
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIE,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/**
 * Express middleware that rejects unauthenticated API calls.
 */
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.sub;
    next();
  } catch {
    clearSessionCookie(res);
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

function isAuthenticated(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return false;
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  verifyCredentials,
  issueToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  isAuthenticated,
  COOKIE_NAME,
};
