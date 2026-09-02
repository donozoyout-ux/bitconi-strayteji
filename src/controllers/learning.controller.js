const learningEngine = require('../services/learning-engine.service');

async function getStatus(req, res) {
  try {
    const status = await learningEngine.getStatus();
    res.status(200).json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function checkNow(req, res) {
  try {
    const result = await learningEngine.maybeRunCheckpoint();
    const status = await learningEngine.getStatus();
    res.status(200).json({ success: true, result, status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = { getStatus, checkNow };
