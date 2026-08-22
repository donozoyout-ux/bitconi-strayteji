const express = require('express');
const settingsService = require('../services/settings.service');

const router = express.Router();

// GET /api/settings - Get all settings
router.get('/', (req, res) => {
  const s = settingsService.get();
  res.status(200).json({ success: true, settings: s });
});

// PUT /api/settings - Update settings
router.put('/', (req, res) => {
  const patch = req.body || {};
  try {
    const result = settingsService.set(patch);
    res.status(200).json({
      success: true,
      settings: result.settings,
      changes: result.changes,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/settings/change-log - Get audit log of setting changes
router.get('/change-log', (req, res) => {
  const log = settingsService.getChangeLog();
  res.status(200).json({ success: true, changeLog: log });
});

// GET /api/settings/defaults - Get default settings values
router.get('/defaults', (req, res) => {
  res.status(200).json({ success: true, defaults: settingsService.DEFAULT_SETTINGS });
});

module.exports = router;