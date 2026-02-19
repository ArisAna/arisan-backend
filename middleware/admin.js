function requireAdmin(req, res, next) {
  if (!req.user.is_admin) {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAdmin };
